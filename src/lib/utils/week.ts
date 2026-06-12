/**
 * Monday-first week math on browser-local Date objects.
 *
 * Foundation for the Sunday-first → Monday-first calendar conversion.
 * Consumed by src/app/(dashboard)/schedule/tabs/DayToDay.tsx.
 * BookingClient.tsx still carries its own local Monday-first helpers
 * (consolidation candidate, parked).
 *
 * Scope contract: every function operates on the browser-local calendar,
 * replicating the existing calendars' local-time semantics exactly — only
 * Monday-first. Deliberately NOT profile-timezone-aware (that investigation
 * is parked separately): no timezone parameters, no toISOString, and Intl
 * is not used at all — month names come from a locale-pinned constant so
 * labels are identical in every environment.
 */

// Locale-pinned en-GB long month names. A const table instead of
// Intl.DateTimeFormat so the output can never vary with the environment's
// default locale or ICU data.
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * Local midnight of the Monday of the week containing `date`.
 *
 * Monday-first weeks: a Sunday input maps to the PREVIOUS Monday (6 days
 * back), never forward. Returns a new Date; never mutates the input.
 */
export function getMondayWeekStart(date: Date): Date {
  // getDay(): 0=Sun … 6=Sat. Re-anchor so Monday = 0, …, Sunday = 6.
  const daysSinceMonday = (date.getDay() + 6) % 7
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysSinceMonday)
  return d
}

/**
 * `date` shifted by `n` calendar days (n may be negative), preserving local
 * time-of-day. Uses setDate on a copy — never millisecond addition — so a
 * DST transition inside the span cannot shift the wall-clock hour.
 * Returns a new Date; never mutates the input.
 */
export function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * The 7 consecutive days of the week starting at `weekStart`.
 * Element 0 is a copy of `weekStart` itself; never mutates the input.
 */
export function getWeekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

/**
 * Human-readable label for the Mon–Sun week starting at `weekStart`:
 *
 *   same month   → "8 – 14 June 2026"
 *   cross-month  → "29 June – 5 July 2026"
 *   cross-year   → "28 December 2026 – 3 January 2027"
 *
 * En dash (–) with a space either side. Month names are locale-pinned
 * (en-GB constants), never the environment default locale.
 */
export function formatWeekLabel(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const startDay = weekStart.getDate()
  const endDay = end.getDate()
  const startMonth = MONTHS_LONG[weekStart.getMonth()]
  const endMonth = MONTHS_LONG[end.getMonth()]
  const startYear = weekStart.getFullYear()
  const endYear = end.getFullYear()

  if (startYear !== endYear) {
    return `${startDay} ${startMonth} ${startYear} – ${endDay} ${endMonth} ${endYear}`
  }
  if (weekStart.getMonth() !== end.getMonth()) {
    return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`
  }
  return `${startDay} – ${endDay} ${startMonth} ${startYear}`
}
