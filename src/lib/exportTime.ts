// src/lib/exportTime.ts
//
// Shared timezone formatting for ALL admin exports (CSV + XLSX). Every export
// renders instant (timestamptz) columns in one settings-driven timezone so the
// four export routes agree exactly. Date-only fields (billing months, training
// start/end dates) are NOT instants and must never pass through the instant
// helpers — they have their own pair (ymdForExcel / formatLongDateOnly).
//
// Two families live here:
//
//   TEXT formatters — return a string for a text cell.
//     formatInstantInTz      'DD/MM/YYYY HH:MM'      (SCREEN consumers, frozen)
//     formatDateInTz         'DD/MM/YYYY'            (SCREEN consumers, frozen)
//     formatLongDateInTz     '21 August 2026'
//     formatTimeInTz         '13:30'
//     formatTimeRangeInTz    '13:30 - 14:30'
//     formatLongInstantInTz  '21 August 2026, 14:05'
//     formatLongDateOnly     '1 August 2026'         (from a bare YYYY-MM-DD)
//
//   EXCEL DATE builders — return a Date the XLSX writer stores as a REAL date
//   cell, so Excel sorts and filters it chronologically instead of lexically.
//     zonedCalendarDateForExcel  (from a timestamptz instant, in tz)
//     ymdForExcel                (from a bare YYYY-MM-DD, no tz conversion)
//
// formatInstantInTz and formatDateInTz are FROZEN: BillingClient.tsx,
// ClassesListClient.tsx, BillingAdminClient.tsx and reports/[id]/page.tsx all
// render on-screen values through them. The export columns moved to the long
// formatters above; the screen ones deliberately did not.
//
// getExportTimezone() is SERVER-ONLY — it reads the setting via the service-role
// admin client. Every other helper here is pure (Intl only) and safe to import
// into client components. To keep the service-role client out of any client
// bundle that imports the pure helpers, getExportTimezone loads the admin client
// through a dynamic import() rather than a top-level import.

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

// True for a Date that Intl can format. Intl.DateTimeFormat.formatToParts throws
// RangeError('Invalid time value') on an unparseable value, which inside an
// export route means a 500 for the whole workbook rather than one blank cell.
function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime())
}

// 'DD/MM/YYYY HH:MM' for a timestamptz instant, rendered in `tz`.
// Modelled on Route D's SAST formatters (en-GB, hour12:false) so every export
// converts an instant to the same wall-clock. Guards the Intl "24:00" quirk.
//
// FROZEN — on-screen consumers depend on this exact shape. Export columns use
// formatLongInstantInTz instead.
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
//
// FROZEN — on-screen consumers depend on this exact shape. Export columns use
// zonedCalendarDateForExcel (a real date cell) or formatLongDateInTz instead.
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

// ---------------------------------------------------------------------------
// Long-form export formatters
//
// The export columns read as prose ('21 August 2026') rather than as the
// all-numeric DD/MM/YYYY, which a US-locale reader parses as the wrong date
// whenever the day is <= 12. The lesson DATE column is not a string at all any
// more (see zonedCalendarDateForExcel); these cover the single instants and the
// CSV, neither of which has a cell type to lean on.
// ---------------------------------------------------------------------------

// '21 August 2026' — the date portion of a timestamptz instant, rendered in `tz`.
export function formatLongDateInTz(value: string | Date, tz: string): string {
  const date = toDate(value)
  if (!isValidDate(date)) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

// '13:30' — the wall-clock time of a timestamptz instant, rendered in `tz`.
// Guards the Intl "24" hour quirk exactly as formatInstantInTz does: some
// en-GB/ICU builds render midnight as hour 24 of the SAME date, so 24 means 00.
export function formatTimeInTz(value: string | Date, tz: string): string {
  const date = toDate(value)
  if (!isValidDate(date)) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${hour}:${get('minute')}`
}

// '13:30 - 14:30' — a lesson's start and end wall-clock, rendered in `tz`.
//
// public.lessons has NO end column; the end is derived exactly as the database's
// own public.lesson_end_time(starts_at, duration_minutes) derives it:
// start + duration_minutes. Instant math on an absolute instant, never a local
// date reconstruction, so a lesson running across midnight or across a DST
// transition still ends at the true wall-clock of its end instant.
//
// A duration that is absent, non-finite or non-positive yields the START time
// alone — never '13:30 - 13:30', which would assert a zero-length class, and
// never a dangling hyphen, which reads as missing data.
export function formatTimeRangeInTz(
  start: string | Date,
  durationMinutes: number | null | undefined,
  tz: string,
): string {
  const startDate = toDate(start)
  if (!isValidDate(startDate)) return ''
  const startText = formatTimeInTz(startDate, tz)
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return startText
  }
  const endDate = new Date(startDate.getTime() + durationMinutes * 60000)
  if (!isValidDate(endDate)) return startText
  return `${startText} - ${formatTimeInTz(endDate, tz)}`
}

// '21 August 2026, 14:05' — a single timestamptz instant rendered in `tz`.
// Composed from the two helpers above rather than from one combined Intl
// pattern, because en-GB inserts ' at ' between a long date and a time; the
// comma form is what the export columns use.
export function formatLongInstantInTz(value: string | Date, tz: string): string {
  const date = toDate(value)
  if (!isValidDate(date)) return ''
  return `${formatLongDateInTz(date, tz)}, ${formatTimeInTz(date, tz)}`
}

// ---------------------------------------------------------------------------
// Excel date-cell builders
//
// ExcelJS writes a Date cell through utils.dateToExcel (node_modules/exceljs/
// lib/utils/utils.js:55), called from cell-xform.js:249 for ValueType.Date:
//
//     dateToExcel(d, date1904) {
//       return 25569 + ( d.getTime() / (24 * 3600 * 1000) ) - (date1904 ? 1462 : 0);
//     }
//
// It reads d.getTime() — the ABSOLUTE epoch instant — not the Date's local or
// UTC calendar components. 25569 is the day count from the Excel epoch to
// 1970-01-01T00:00:00Z, so the serial lands on a whole number (midnight, no
// time fraction) only when the Date IS exactly midnight UTC of the target day.
// date1904 is undefined here: Workbook's constructor sets `this.properties = {}`
// (lib/doc/workbook.js:23), xlsx.js:620 passes model.properties.date1904 through,
// and buildExportWorkbook never sets it — so the 1900 system applies and no 1462
// correction is subtracted.
//
// Hence Date.UTC(y, m - 1, d). Building the Date with the local constructor
// (new Date(y, m - 1, d)) shifts the serial by the HOST's offset — on a UTC+2
// box 21 Aug becomes serial 46254.9166…, i.e. 20 Aug 22:00 — so the exported day
// would depend on which machine rendered it. Verified against exceljs 4.x by
// round-tripping a cell: Date.UTC(2026, 7, 21) writes serial 46255 and reads
// back as 2026-08-21T00:00:00.000Z, type 4 (ValueType.Date).
// ---------------------------------------------------------------------------

// The calendar y/m/d that an instant falls on in `tz`. Date parts only — with no
// hour requested there is no "24" quirk to guard on this path.
function ymdPartsInTz(date: Date, tz: string): { y: number; m: number; d: number } | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const y = get('year')
  const m = get('month')
  const d = get('day')
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return { y, m, d }
}

// A timestamptz instant as a REAL Excel date cell for the calendar day it falls
// on in `tz`. Returns midnight UTC of that day, which ExcelJS serialises as a
// whole-number serial (see the dateToExcel note above) — so 20 Aug 23:30 UTC
// exports as 21 August 2026 for Africa/Johannesburg, the same day the Time
// column shows, and Excel sorts the column chronologically.
//
// null (never an Invalid Date) for an unparseable value: dateToExcel would turn
// NaN into a NaN serial and write <v>NaN</v>, which Excel refuses to open.
// buildExportWorkbook renders null as an empty cell.
export function zonedCalendarDateForExcel(value: string | Date, tz: string): Date | null {
  const date = toDate(value)
  if (!isValidDate(date)) return null
  let ymd: { y: number; m: number; d: number } | null = null
  try {
    ymd = ymdPartsInTz(date, tz)
  } catch {
    // Unknown IANA zone — Intl throws RangeError. One bad setting must not take
    // the whole workbook down with it.
    return null
  }
  if (!ymd) return null
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d))
}

// Parse the leading 'YYYY-MM-DD' of a date-only value. Tolerates a trailing time
// (the formatDate this replaced did iso.slice(0, 10)) and rejects a date that
// does not exist — '2026-02-31' would otherwise roll silently into March.
function parseYmdString(value: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!value) return null
  const [ys, ms, ds] = value.slice(0, 10).split('-')
  if (ys?.length !== 4 || ms?.length !== 2 || ds?.length !== 2) return null
  const y = Number(ys)
  const m = Number(ms)
  const d = Number(ds)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null
  }
  return { y, m, d }
}

// A date-only 'YYYY-MM-DD' (a Postgres `date` column: training start/end) as a
// REAL Excel date cell. NO timezone conversion — a `date` has no instant and no
// zone, so shifting it by an export timezone would move a training's start date
// by a day. Same Date.UTC construction as zonedCalendarDateForExcel, for the
// same dateToExcel reason. null on empty or malformed input.
export function ymdForExcel(ymd: string | null | undefined): Date | null {
  const parts = parseYmdString(ymd)
  if (!parts) return null
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d))
}

// '1 August 2026' from a date-only 'YYYY-MM-DD', for the CSV export, which has
// no cell type and must carry the long text form. Formatted with timeZone 'UTC'
// against the same Date.UTC construction, so the rendered day is exactly the
// stored day in every host timezone. '' on empty or malformed input.
export function formatLongDateOnly(ymd: string | null | undefined): string {
  const date = ymdForExcel(ymd)
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
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
