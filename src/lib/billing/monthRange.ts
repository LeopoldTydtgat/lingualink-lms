export interface MonthRange {
  startUtc: string  // ISO timestamp for .gte() filter
  endUtc: string    // ISO timestamp for .lt() filter
  monthKey: string  // 'YYYY-MM-01' for grouping
}

export interface DayRange {
  startUtc: string  // ISO timestamp for .gte() filter — local midnight of the day, in UTC
  endUtc: string    // ISO timestamp for .lt() filter — local midnight of the NEXT day, in UTC
}

// Convert a local calendar date (year, month, day) at midnight to a UTC ISO string.
// Two-pass approach: probe the timezone offset via Intl, then apply the correction.
// Handles DST correctly. Follows the pattern in src/app/api/admin/classes/route.ts.
function localMidnightToUtc(year: number, month: number, day: number, tz: string): string {
  const probe = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(probe)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value)
  const diffMs =
    Date.UTC(year, month - 1, day, 0, 0, 0) -
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), 0)
  return new Date(probe.getTime() + diffMs).toISOString()
}

export function getMonthKeyInTz(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parseInt(parts.find(p => p.type === 'year')!.value)
  const month = parseInt(parts.find(p => p.type === 'month')!.value)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function getMonthRangeInTz(date: Date, timezone: string): MonthRange {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parseInt(parts.find(p => p.type === 'year')!.value)
  const month = parseInt(parts.find(p => p.type === 'month')!.value)

  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1

  const monthKey = `${year}-${String(month).padStart(2, '0')}-01`
  const startUtc = localMidnightToUtc(year, month, 1, timezone)
  const endUtc = localMidnightToUtc(nextYear, nextMonth, 1, timezone)

  return { startUtc, endUtc, monthKey }
}

// Returns the UTC boundaries of the local calendar DAY that `date` falls on,
// in the given timezone. Mirrors getMonthRangeInTz but for a single day.
// Used by the admin dashboard "today" range so it is correct in any admin's
// own timezone, not a hardcoded offset.
export function getDayRangeInTz(date: Date, timezone: string): DayRange {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parseInt(parts.find(p => p.type === 'year')!.value)
  const month = parseInt(parts.find(p => p.type === 'month')!.value)
  const day = parseInt(parts.find(p => p.type === 'day')!.value)

  // Next calendar day, handling month/year rollover via the Date constructor.
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const nextYear = next.getUTCFullYear()
  const nextMonth = next.getUTCMonth() + 1
  const nextDay = next.getUTCDate()

  const startUtc = localMidnightToUtc(year, month, day, timezone)
  const endUtc = localMidnightToUtc(nextYear, nextMonth, nextDay, timezone)

  return { startUtc, endUtc }
}
