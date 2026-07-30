import { wallTimeToUtcMs } from '@/lib/utils/timezone'

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
// Thin wrapper over wallTimeToUtcMs in @/lib/utils/timezone — the one DST-correct
// local->UTC primitive in the project, shared with localToUtc and localTimeToUtcMs.
// Exported so the admin classes GET filter resolves its yyyy-mm-dd edges through this
// same math rather than re-deriving it — one definition of "local midnight".
//
// The previous implementation claimed "two-pass" but was single-pass: it read the
// offset at midnight-reinterpreted-as-UTC and never re-derived it at the resulting
// instant, so any month or day boundary sitting on the far side of a DST transition
// from that probe came out an hour off — a billing window that started or ended in the
// wrong hour, and on a boundary day the wrong set of lessons.
//
// Zones whose DST jump happens AT midnight (America/Santiago, Asia/Beirut) have no
// 00:00 at all on their spring-forward date; per the wallTimeToUtcMs gap contract this
// returns 01:00 local, which is the genuine first instant of that calendar day. A
// half-open [start, end) range built from two such calls stays exactly contiguous —
// no gap, no overlap, nothing double-counted. On a fall-back date the ambiguous
// midnight resolves to its FIRST occurrence, so the range covers all 25 hours.
export function localMidnightToUtc(year: number, month: number, day: number, tz: string): string {
  return new Date(wallTimeToUtcMs(year, month, day, 0, 0, tz)).toISOString()
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

// The calendar year/month/day that `date` falls on in the given timezone. Single
// source of the "which local day is this?" answer, shared by getDayRangeInTz (the
// admin dashboard's "Classes Today" bucketing) and getDayKeyInTz below — so a date
// filter seeded from the key can never disagree with the count.
function ymdInTz(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  return {
    year: parseInt(parts.find(p => p.type === 'year')!.value),
    month: parseInt(parts.find(p => p.type === 'month')!.value),
    day: parseInt(parts.find(p => p.type === 'day')!.value),
  }
}

// 'YYYY-MM-DD' for the local calendar day `date` falls on in the given timezone.
// Never toISOString here — that yields the UTC day, which is a different day for
// any timezone whose offset pushes the instant across midnight.
export function getDayKeyInTz(date: Date, timezone: string): string {
  const { year, month, day } = ymdInTz(date, timezone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Returns the UTC boundaries of the local calendar DAY that `date` falls on,
// in the given timezone. Mirrors getMonthRangeInTz but for a single day.
// Used by the admin dashboard "today" range so it is correct in any admin's
// own timezone, not a hardcoded offset.
export function getDayRangeInTz(date: Date, timezone: string): DayRange {
  const { year, month, day } = ymdInTz(date, timezone)

  // Next calendar day, handling month/year rollover via the Date constructor.
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const nextYear = next.getUTCFullYear()
  const nextMonth = next.getUTCMonth() + 1
  const nextDay = next.getUTCDate()

  const startUtc = localMidnightToUtc(year, month, day, timezone)
  const endUtc = localMidnightToUtc(nextYear, nextMonth, nextDay, timezone)

  return { startUtc, endUtc }
}
