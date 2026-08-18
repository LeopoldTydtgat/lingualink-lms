import { describe, it, expect } from 'vitest'
import {
  formatDayDate,
  formatMonth,
  isoWeekday,
  endOfWeekKey,
  endOfMonthKey,
  formatDayHeading,
  formatDayDivider,
} from './agendaDates'

/**
 * Tests for src/lib/lessons/agendaDates.ts - the day and month labels, the
 * Today/Tomorrow divider text and the "This Week" / "This Month" range bounds
 * shared by the teacher and student agenda lists.
 *
 * Why this file exists: these helpers used to live inside one component, where
 * a wrong answer was visible only by reading the rendered agenda on the right
 * day in the right timezone. Now that two portals call them, a regression is
 * two bugs at once. Every case below is an asserted in/out pair on a fixed date
 * and a fixed IANA zone - never the machine's local zone, which would make the
 * suite pass on one developer's laptop and fail in CI.
 *
 * The module is pure: no clock is read anywhere in it, so todayKey is always
 * supplied here as a literal, exactly as the components supply it from an
 * effect.
 */

// Fixed reference day: Tuesday 18 August 2026. Every date key below is checked
// against a real calendar, not against the code under test.
const TZ = 'Europe/Madrid'
const AUG_18_MIDDAY = '2026-08-18T10:00:00.000Z' // 12:00 in Madrid (CEST, UTC+2)

describe('isoWeekday', () => {
  it('returns 1 for a Monday', () => {
    // Mon 17 Aug 2026.
    expect(isoWeekday('2026-08-17')).toBe(1)
  })

  it('returns 7 for a Sunday, not 0', () => {
    // Sun 16 Aug 2026. Sakamoto is Sunday-zero internally; the ISO remap to 7
    // is what endOfWeekKey's "already the end of the week" case depends on.
    expect(isoWeekday('2026-08-16')).toBe(7)
  })

  it('returns 2 for the Tuesday between them', () => {
    expect(isoWeekday('2026-08-18')).toBe(2)
  })

  it('handles January, where Sakamoto shifts the year back', () => {
    // Mon 5 Jan 2026. m < 3 takes the yy = y - 1 branch, so a wrong shift there
    // would put every January heading a day out while the rest of the year
    // stayed correct.
    expect(isoWeekday('2026-01-05')).toBe(1)
  })

  it('handles a leap day', () => {
    // Tue 29 Feb 2028.
    expect(isoWeekday('2028-02-29')).toBe(2)
  })
})

describe('endOfWeekKey', () => {
  it('returns the coming Sunday from a midweek key', () => {
    // Tue 18 Aug -> Sun 23 Aug, five days on.
    expect(endOfWeekKey('2026-08-18')).toBe('2026-08-23')
  })

  it('returns a Sunday key unchanged', () => {
    // The week already ends today, so the bound is the key itself. Adding a
    // rolling seven here would let "This Week" reach a week into the next one.
    expect(endOfWeekKey('2026-08-23')).toBe('2026-08-23')
  })

  it('crosses a month boundary when the week does', () => {
    // Mon 31 Aug -> Sun 6 Sept.
    expect(endOfWeekKey('2026-08-31')).toBe('2026-09-06')
  })
})

describe('endOfMonthKey', () => {
  it('ends a 31-day month on the 31st', () => {
    expect(endOfMonthKey('2026-08-18')).toBe('2026-08-31')
  })

  it('ends a 30-day month on the 30th', () => {
    expect(endOfMonthKey('2026-09-10')).toBe('2026-09-30')
  })

  it('ends February on the 29th in a leap year', () => {
    expect(endOfMonthKey('2028-02-10')).toBe('2028-02-29')
  })

  it('ends February on the 28th in a common year', () => {
    expect(endOfMonthKey('2027-02-10')).toBe('2027-02-28')
  })

  it('treats 2100 as a common year (divisible by 100, not by 400)', () => {
    // The half of the Gregorian rule a naive "y % 4 === 0" gets wrong.
    expect(endOfMonthKey('2100-02-10')).toBe('2100-02-28')
  })

  it('treats 2000 as a leap year (divisible by 400)', () => {
    // The other half: the % 100 exclusion must not swallow it.
    expect(endOfMonthKey('2000-02-10')).toBe('2000-02-29')
  })

  it("returns the last day of the key's OWN month, whatever day the key is", () => {
    // The bound must not roll into September just because the key is late in
    // August - that is the "This Month reached 16 Sept" bug this replaced.
    expect(endOfMonthKey('2026-08-01')).toBe('2026-08-31')
    expect(endOfMonthKey('2026-08-31')).toBe('2026-08-31')
  })
})

describe('formatDayDate', () => {
  it('formats the absolute date in the supplied zone', () => {
    expect(formatDayDate(AUG_18_MIDDAY, TZ)).toBe('Tue 18 Aug')
  })

  it('labels one instant by the calendar day it falls on IN THAT ZONE', () => {
    // 23:30Z on 18 Aug is already 01:30 on the 19th in Madrid. The same instant
    // must therefore print a different day in the two zones - reading the date
    // off the browser instead of the account zone is how a row near midnight
    // ends up under the wrong divider.
    const lateEvening = '2026-08-18T23:30:00.000Z'
    expect(formatDayDate(lateEvening, TZ)).toBe('Wed 19 Aug')
    expect(formatDayDate(lateEvening, 'UTC')).toBe('Tue 18 Aug')
  })
})

describe('formatMonth', () => {
  it('returns the upper-case month and year in the supplied zone', () => {
    expect(formatMonth(AUG_18_MIDDAY, TZ)).toBe('AUGUST 2026')
  })

  it('names the month the day belongs to in that zone, not in UTC', () => {
    // 23:30Z on 31 Aug is 1 Sept in Madrid, so the separator above the row and
    // the divider beneath it must both say September.
    const monthEdge = '2026-08-31T23:30:00.000Z'
    expect(formatMonth(monthEdge, TZ)).toBe('SEPTEMBER 2026')
    expect(formatMonth(monthEdge, 'UTC')).toBe('AUGUST 2026')
  })
})

describe('formatDayHeading', () => {
  it("returns 'Today' when the group key is today's key", () => {
    expect(formatDayHeading(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-18')).toBe('Today')
  })

  it("returns 'Tomorrow' for the key one day after today's", () => {
    expect(formatDayHeading(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-17')).toBe('Tomorrow')
  })

  it('returns the absolute date when todayKey is null (pre-mount)', () => {
    // Null is the server pass and the first client pass. It must fall back to
    // the absolute date rather than guessing, so SSR and hydration agree.
    expect(formatDayHeading(AUG_18_MIDDAY, TZ, '2026-08-18', null)).toBe('Tue 18 Aug')
  })

  it('returns the absolute date for any other day', () => {
    expect(formatDayHeading(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-16')).toBe('Tue 18 Aug')
  })

  it('decides Today/Tomorrow on the keys alone, never on the instant', () => {
    // Same keys, a zone eight hours away: the relative label is a comparison of
    // two date keys the caller already built in the account zone, so the
    // formatter's zone cannot move it.
    expect(formatDayHeading(AUG_18_MIDDAY, 'Asia/Tokyo', '2026-08-18', '2026-08-18')).toBe('Today')
  })
})

describe('formatDayDivider', () => {
  it('returns the bare absolute date when no relative label applies', () => {
    // formatDayHeading returned the absolute date itself, so prefixing it would
    // print "Tue 18 Aug - Tue 18 Aug".
    expect(formatDayDivider(AUG_18_MIDDAY, TZ, '2026-08-18', null)).toBe('Tue 18 Aug')
    expect(formatDayDivider(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-16')).toBe('Tue 18 Aug')
  })

  it("prefixes 'Today' onto the absolute date", () => {
    expect(formatDayDivider(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-18')).toBe('Today - Tue 18 Aug')
  })

  it("prefixes 'Tomorrow' onto the absolute date", () => {
    expect(formatDayDivider(AUG_18_MIDDAY, TZ, '2026-08-18', '2026-08-17')).toBe('Tomorrow - Tue 18 Aug')
  })
})
