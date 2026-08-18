import { addDaysToDateKey } from '@/lib/utils/timezone'

// Pure date helpers behind the flat agenda lists - the day and month labels, the
// Today/Tomorrow divider text, and the "This Week" / "This Month" range bounds.
//
// Lifted out of the teacher's UpcomingClassesClient so the student portal can render the
// same agenda without a second copy: two copies of a date rule is how two portals end up
// disagreeing about which day a class falls on.
//
// formatDayDate is that component's former formatDate, renamed on the way out because
// "formatDate" says nothing about which date it formats.
//
// PURE, and must stay that way: no Date.now(), no clock read, no React, no 'use client'.
// todayKey arrives as a parameter, exactly as it does in the component - a clock read here
// would be impure under react-hooks/purity in every caller and would make an SSR pass
// disagree with hydration.

export function formatDayDate(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(isoString))
}

// Full month and year for the month separator, read off the day's own first class in the
// account holder's own timezone - the same source and the same zone formatDayDate uses,
// so a separator can never name a different month from the divider directly beneath it.
export function formatMonth(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(isoString)).toUpperCase()
}

// ISO weekday (Monday = 1 ... Sunday = 7) of a YYYY-MM-DD key, by Sakamoto's closed-form
// day-of-week. Pure arithmetic on the triple: no Date, no local formatting, so nothing
// between the key and its weekday can shift with the browser's zone.
export function isoWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  const monthOffsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = m < 3 ? y - 1 : y
  const sundayZero =
    (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + monthOffsets[m - 1] + d) % 7
  return sundayZero === 0 ? 7 : sundayZero
}

// The coming Sunday's key - the end of the week the user is actually in, not a rolling
// six days. On a Sunday the week already ends today, so the bound is dateKey itself.
export function endOfWeekKey(dateKey: string): string {
  return addDaysToDateKey(dateKey, 7 - isoWeekday(dateKey))
}

// The last day of dateKey's OWN calendar month, so "This Month" cannot reach into the next
// one. The year-month prefix is sliced off the key rather than reformatted, and February's
// leap day is decided by the Gregorian rule instead of by Date rollover.
export function endOfMonthKey(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number)
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const lastDay = m === 2 && isLeap ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return `${dateKey.slice(0, 8)}${String(lastDay).padStart(2, '0')}`
}

// Today/Tomorrow must be decided on the SAME day boundary that built the group this
// heading labels - the account holder's own timezone, not the browser's. date-fns
// isToday/isTomorrow compare Date objects on the browser's boundary, so a user whose
// device zone differs from their account zone read a heading one day off near midnight
// while the group beneath it was correct.
//
// dateKey is the group's own key, already produced by getLocalDateKey in the account
// holder's own timezone; todayKey is supplied by the caller from a clock read in an
// effect, never during render (react-hooks/purity is ON in the calling components).
export function formatDayHeading(isoString: string, timezone: string, dateKey: string, todayKey: string | null): string {
  if (todayKey !== null) {
    if (dateKey === todayKey) return 'Today'
    if (dateKey === addDaysToDateKey(todayKey, 1)) return 'Tomorrow'
  }
  return formatDayDate(isoString, timezone)
}

// The agenda divider carries the whole date: the rows beneath it print time only, so this
// is the only place a reader learns which day they are looking at. formatDayHeading
// returns the absolute date itself when no relative label applies, so comparing the two is
// what decides whether Today/Tomorrow gets prefixed rather than duplicated.
//
// Pure, like everything it calls: the relative label comes from the caller's todayKey,
// which was read from the clock in an effect, never here.
export function formatDayDivider(isoString: string, timezone: string, dateKey: string, todayKey: string | null): string {
  const absolute = formatDayDate(isoString, timezone)
  const relative = formatDayHeading(isoString, timezone, dateKey, todayKey)
  return relative === absolute ? absolute : `${relative} - ${absolute}`
}
