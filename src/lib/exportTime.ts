// src/lib/exportTime.ts
//
// Shared timezone formatting for ALL admin exports (CSV + XLSX). Every export
// renders instant (timestamptz) columns in one settings-driven timezone so the
// four export routes agree exactly. Date-only fields (billing months, training
// start/end dates) are NOT instants and must never pass through these helpers.
//
// getExportTimezone() is SERVER-ONLY — it reads the setting via the service-role
// admin client. The formatInstantInTz / formatDateInTz / tzLabel helpers are pure
// (Intl only) and safe to import into client components. To keep the service-role
// client out of any client bundle that imports the pure helpers, getExportTimezone
// loads the admin client through a dynamic import() rather than a top-level import.

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
