// src/lib/exportTime.ts
//
// Shared timezone formatting for ALL admin exports (CSV + XLSX). Every export
// renders instant (timestamptz) columns in one settings-driven timezone so the
// four export routes agree exactly. Date-only fields (billing months, training
// start/end dates) are NOT instants and must never pass through these helpers.
//
// getExportTimezone() is SERVER-ONLY — it reads the setting via the service-role
// admin client. The formatInstantInTz / formatDateInTz / tzLabel /
// zonedDayRangeToUtcBounds helpers are pure (Intl only) and safe to import into
// client components. To keep the service-role client out of any client bundle
// that imports the pure helpers, getExportTimezone loads the admin client through
// a dynamic import() rather than a top-level import.

export const EXPORT_TZ_FALLBACK = 'Africa/Johannesburg'

// Short, human label for a column header, derived from the IANA zone. Never a
// hardcoded 'SAST' literal — the configured zones map to their abbreviations
// (slash form where the zone observes DST, since a single header can span both
// standard and summer time), with an Intl-derived fallback for any other zone.
const TZ_LABELS: Record<string, string> = {
  'Africa/Johannesburg': 'SAST',
  'Europe/London': 'GMT/BST',
  'Europe/Lisbon': 'WET/WEST',
  'Europe/Madrid': 'CET/CEST',
  'Europe/Paris': 'CET/CEST',
  'Europe/Berlin': 'CET/CEST',
}

// The only zones the exports guarantee correct day-boundary math for — none of
// them transitions at local midnight (see the ASSUMPTION note lower in this
// file). Single source of truth for validating the export_timezone setting.
export const EXPORT_TZ_ALLOWED = Object.keys(TZ_LABELS)

export function tzLabel(tz: string): string {
  if (TZ_LABELS[tz]) return TZ_LABELS[tz]
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(new Date())
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

// 'DD/MM/YYYY HH:MM' for a timestamptz instant, rendered in `tz`.
// Modelled on Route D's SAST formatters (en-GB, hour12:false) so every export
// converts an instant to the same wall-clock. Guards the Intl "24:00" quirk.
export function formatInstantInTz(value: string | Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(toDate(value))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('day')}/${get('month')}/${get('year')} ${hour}:${get('minute')}`
}

// 'DD/MM/YYYY' — the date portion of a timestamptz instant, rendered in `tz`.
export function formatDateInTz(value: string | Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(toDate(value))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('day')}/${get('month')}/${get('year')}`
}

function isValidTimeZone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Zoned calendar-day → UTC instant bounds (NEW273)
//
// Export routes scope rows by a [date_from, date_to] calendar-day window that
// the admin picked in the SETTINGS-DRIVEN export timezone, but `scheduled_at` is
// a timestamptz (an absolute instant). Turning those local days into instants
// with a hardcoded offset scopes the row set in one zone while the display
// columns render in another, so boundary-day lessons appear in — or fall out of
// — the wrong window. These helpers resolve the bounds in the SAME zone the
// export renders in.
//
// ASSUMPTION: none of the supported zones transition at local midnight — every
// one of them (Africa/Johannesburg never transitions at all; the European zones
// shift between 01:00 and 03:00 local) leaves local 00:00 a real, unambiguous
// wall-clock instant. There is therefore no spring-forward gap to resolve at a
// day boundary, and the two-pass technique below always converges.
// ---------------------------------------------------------------------------

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

type Ymd = { y: number; m: number; d: number }

// Parse 'YYYY-MM-DD' into calendar parts. Rejects non-existent dates (e.g.
// '2026-02-31', which would otherwise roll over silently into March).
function parseYmd(value: string): Ymd | null {
  const match = YMD_RE.exec(value)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null
  }
  return { y, m, d }
}

// Next calendar day, via UTC date arithmetic only. Date.UTC normalises month and
// year rollover (31 Dec → 1 Jan), and nothing here reads the host timezone, so
// the result never depends on where the server runs.
function addOneDay({ y, m, d }: Ymd): Ymd {
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }
}

function ymdToString({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// The UTC offset of `tz`, in minutes, AT a specific absolute instant. Formats the
// instant in `tz` and compares the resulting zone-local wall clock against the
// same instant's UTC wall clock; the difference IS the offset. Positive is east
// of UTC (SAST = +120). Computed per instant because the European zones observe
// DST — the offset on date_from and on the day after date_to can differ.
function tzOffsetMinutesAt(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  // Intl renders midnight as '24' in some en-GB/ICU builds; the date part stays
  // on the same day, so 24 means hour 0 of that date (matches formatInstantInTz).
  const hour = get('hour') === 24 ? 0 : get('hour')
  const localWallClockAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return Math.round((localWallClockAsUtc - utcMs) / 60000)
}

// The absolute UTC instant of local 00:00:00 on `day` in `tz`.
// Treat local midnight as if it were UTC, then subtract the zone's offset. The
// offset must be sampled AT the target instant, not at the probe, so we take a
// second pass: re-derive the offset at the candidate and adjust once if a DST
// transition moved it. One correction always suffices (see the ASSUMPTION note).
function zonedMidnightUtcMs(day: Ymd, tz: string): number {
  const midnightAsUtc = Date.UTC(day.y, day.m - 1, day.d)
  const firstOffset = tzOffsetMinutesAt(midnightAsUtc, tz)
  const candidate = midnightAsUtc - firstOffset * 60000
  const secondOffset = tzOffsetMinutesAt(candidate, tz)
  return secondOffset === firstOffset ? candidate : midnightAsUtc - secondOffset * 60000
}

// Old pre-NEW273 behaviour: a hardcoded +02:00 (SAST) literal, converted to a UTC
// ISO instant. Parsing a string that carries its own explicit offset is absolute
// and host-timezone-independent. If the date is unparseable the literal itself is
// returned — PostgREST accepts it verbatim, exactly as the old code passed it.
function sastLiteralToUtcIso(literal: string): string {
  const ms = Date.parse(literal)
  return Number.isNaN(ms) ? literal : new Date(ms).toISOString()
}

function sastFallbackBounds(dateFrom: string, dateTo: string): { gteIso: string; ltIso: string } {
  const to = parseYmd(dateTo)
  return {
    gteIso: sastLiteralToUtcIso(`${dateFrom}T00:00:00+02:00`),
    // Half-open upper bound where date_to parses; otherwise degrade to the old
    // inclusive end-of-day instant rather than throwing.
    ltIso: to
      ? sastLiteralToUtcIso(`${ymdToString(addOneDay(to))}T00:00:00+02:00`)
      : sastLiteralToUtcIso(`${dateTo}T23:59:59.999+02:00`),
  }
}

// Resolve an inclusive [dateFrom, dateTo] range of LOCAL calendar days in `tz`
// into a HALF-OPEN pair of UTC ISO instants for a timestamptz query:
//
//   .gte('scheduled_at', gteIso).lt('scheduled_at', ltIso)
//
//   gteIso — local 00:00:00 on dateFrom, in tz
//   ltIso  — local 00:00:00 on the day AFTER dateTo, in tz
//
// Both dateFrom and dateTo are covered as full local days, with no 23:59:59
// sub-second gap at the top of the range. Never throws: an unparseable date or
// an unknown zone falls back to the pre-NEW273 hardcoded +02:00 bounds, matching
// the fail-safe style of getExportTimezone.
export function zonedDayRangeToUtcBounds(
  dateFrom: string,
  dateTo: string,
  tz: string,
): { gteIso: string; ltIso: string } {
  try {
    const from = parseYmd(dateFrom)
    const to = parseYmd(dateTo)
    if (!from || !to || !isValidTimeZone(tz)) return sastFallbackBounds(dateFrom, dateTo)
    return {
      gteIso: new Date(zonedMidnightUtcMs(from, tz)).toISOString(),
      ltIso: new Date(zonedMidnightUtcMs(addOneDay(to), tz)).toISOString(),
    }
  } catch (err) {
    console.error('zonedDayRangeToUtcBounds failed; falling back to +02:00 bounds:', err)
    return sastFallbackBounds(dateFrom, dateTo)
  }
}

// SERVER-ONLY. Reads settings.key='export_timezone' via the service-role admin
// client (settings has RLS; the export routes are already admin-gated). Fails
// safe to EXPORT_TZ_FALLBACK when the row is missing, empty, or not a valid IANA
// zone. Dynamic import keeps the service-role client out of client bundles that
// import the pure formatters above.
export async function getExportTimezone(): Promise<string> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('settings')
      .select('value')
      .eq('key', 'export_timezone')
      .maybeSingle()
    if (error) {
      console.error('getExportTimezone settings read failed:', error)
      return EXPORT_TZ_FALLBACK
    }
    const tz = data?.value?.trim()
    return tz && isValidTimeZone(tz) ? tz : EXPORT_TZ_FALLBACK
  } catch (err) {
    console.error('getExportTimezone threw:', err)
    return EXPORT_TZ_FALLBACK
  }
}
