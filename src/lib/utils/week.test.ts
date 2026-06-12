import { describe, it, expect } from 'vitest'
import { getMondayWeekStart, addDays, getWeekDays, formatWeekLabel } from '@/lib/utils/week'

/**
 * Tests for src/lib/utils/week.ts — Monday-first week math on browser-local
 * Dates, foundation for the Sunday-first → Monday-first calendar conversion.
 *
 * Every assertion reads LOCAL date parts (getFullYear/getMonth/getDate/
 * getHours…) or exact label strings — never toISOString — so the suite
 * passes identically in any system timezone.
 *
 * Fixture weekdays were verified by calculation (Zeller's congruence,
 * cross-checked against the 1 Jan 2024 = Monday anchor), not memory:
 *
 *   Mon  8 Jun 2026   Wed 10 Jun 2026   Sat 13 Jun 2026   Sun 14 Jun 2026
 *   Mon 29 Jun 2026   Wed  1 Jul 2026
 *   Thu  1 Jan 2026 → its week's Monday is 29 Dec 2025 (28 Dec 2025 is a SUNDAY)
 *   Mon 28 Dec 2026 → week ends Sun 3 Jan 2027
 */

// Local date parts as a comparable triple. Months stay 0-based on purpose so
// a failure prints exactly what the Date getters returned.
function ymd(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth(), d.getDate()]
}

describe('getMondayWeekStart', () => {
  // ── The defining Monday-first edge ────────────────────────────────────────
  // Sunday must map BACK to the previous Monday (6 days), never forward.
  it('Sunday input → previous Monday: Sun 14 Jun 2026 noon → Mon 8 Jun 2026', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 14, 12, 0))
    expect(ymd(result)).toEqual([2026, 5, 8])
  })

  it('Sunday at 23:59:59.999 (last instant of the week) still → previous Monday', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 14, 23, 59, 59, 999))
    expect(ymd(result)).toEqual([2026, 5, 8])
  })

  it('Monday input → the same day at local midnight', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 8, 15, 30, 45, 500))
    expect(ymd(result)).toEqual([2026, 5, 8])
    expect(result.getHours()).toBe(0)
  })

  it('Monday exactly at midnight → unchanged, but a NEW Date object', () => {
    const input = new Date(2026, 5, 8)
    const result = getMondayWeekStart(input)
    expect(ymd(result)).toEqual([2026, 5, 8])
    expect(result.getHours()).toBe(0)
    expect(result).not.toBe(input)
  })

  it('midweek input: Wed 10 Jun 2026 → Mon 8 Jun 2026', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 10, 9, 0))
    expect(ymd(result)).toEqual([2026, 5, 8])
  })

  it('Saturday input: Sat 13 Jun 2026 → Mon 8 Jun 2026 (5 days back)', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 13, 23, 59))
    expect(ymd(result)).toEqual([2026, 5, 8])
  })

  // ── Boundary crossings ────────────────────────────────────────────────────
  it('month boundary: Wed 1 Jul 2026 → Mon 29 Jun 2026', () => {
    const result = getMondayWeekStart(new Date(2026, 6, 1))
    expect(ymd(result)).toEqual([2026, 5, 29])
  })

  // 1 Jan 2026 is a Thursday; the Monday of that week is 3 days back in the
  // previous year. (29 Dec 2025 is the Monday — 28 Dec 2025 is a Sunday.)
  it('year boundary: Thu 1 Jan 2026 → Mon 29 Dec 2025', () => {
    const result = getMondayWeekStart(new Date(2026, 0, 1))
    expect(ymd(result)).toEqual([2025, 11, 29])
  })

  // ── Result shape ──────────────────────────────────────────────────────────
  it('result is local midnight: h/m/s/ms all zero', () => {
    const result = getMondayWeekStart(new Date(2026, 5, 10, 15, 42, 33, 123))
    expect(result.getHours()).toBe(0)
    expect(result.getMinutes()).toBe(0)
    expect(result.getSeconds()).toBe(0)
    expect(result.getMilliseconds()).toBe(0)
  })

  it('never mutates the input Date', () => {
    const input = new Date(2026, 5, 14, 12, 34, 56, 789)
    const before = input.getTime()
    getMondayWeekStart(input)
    expect(input.getTime()).toBe(before)
  })
})

describe('addDays', () => {
  it('positive: 8 Jun 2026 + 3 → 11 Jun 2026', () => {
    expect(ymd(addDays(new Date(2026, 5, 8), 3))).toEqual([2026, 5, 11])
  })

  it('negative: 8 Jun 2026 − 7 → 1 Jun 2026', () => {
    expect(ymd(addDays(new Date(2026, 5, 8), -7))).toEqual([2026, 5, 1])
  })

  it('month rollover forwards: 30 Jun 2026 + 1 → 1 Jul 2026', () => {
    expect(ymd(addDays(new Date(2026, 5, 30), 1))).toEqual([2026, 6, 1])
  })

  it('month rollover backwards: 1 Jul 2026 − 1 → 30 Jun 2026', () => {
    expect(ymd(addDays(new Date(2026, 6, 1), -1))).toEqual([2026, 5, 30])
  })

  it('year rollover forwards: 30 Dec 2026 + 3 → 2 Jan 2027', () => {
    expect(ymd(addDays(new Date(2026, 11, 30), 3))).toEqual([2027, 0, 2])
  })

  it('year rollover backwards: 2 Jan 2026 − 5 → 28 Dec 2025', () => {
    expect(ymd(addDays(new Date(2026, 0, 2), -5))).toEqual([2025, 11, 28])
  })

  it('preserves local time-of-day across the shift', () => {
    const result = addDays(new Date(2026, 5, 8, 13, 45, 30, 250), 1)
    expect(ymd(result)).toEqual([2026, 5, 9])
    expect(result.getHours()).toBe(13)
    expect(result.getMinutes()).toBe(45)
    expect(result.getSeconds()).toBe(30)
    expect(result.getMilliseconds()).toBe(250)
  })

  it('n = 0 returns an equal but NEW Date object', () => {
    const input = new Date(2026, 5, 8, 10, 0)
    const result = addDays(input, 0)
    expect(result.getTime()).toBe(input.getTime())
    expect(result).not.toBe(input)
  })

  it('never mutates the input Date', () => {
    const input = new Date(2026, 5, 8, 10, 0)
    const before = input.getTime()
    addDays(input, 14)
    addDays(input, -14)
    expect(input.getTime()).toBe(before)
  })
})

describe('getWeekDays', () => {
  it('returns exactly 7 days', () => {
    expect(getWeekDays(new Date(2026, 5, 8))).toHaveLength(7)
  })

  it('starts at weekStart (same calendar day, as a copy — not the same object)', () => {
    const weekStart = new Date(2026, 5, 8)
    const days = getWeekDays(weekStart)
    expect(ymd(days[0])).toEqual([2026, 5, 8])
    expect(days[0]).not.toBe(weekStart)
  })

  // Cross-month week pins consecutiveness AND the Jun → Jul rollover at once:
  // Mon 29 Jun 2026 … Sun 5 Jul 2026.
  it('days are consecutive across a month boundary', () => {
    const days = getWeekDays(new Date(2026, 5, 29))
    expect(days.map(ymd)).toEqual([
      [2026, 5, 29],
      [2026, 5, 30],
      [2026, 6, 1],
      [2026, 6, 2],
      [2026, 6, 3],
      [2026, 6, 4],
      [2026, 6, 5],
    ])
  })

  it('never mutates the input Date', () => {
    const weekStart = new Date(2026, 5, 8)
    const before = weekStart.getTime()
    getWeekDays(weekStart)
    expect(weekStart.getTime()).toBe(before)
  })
})

describe('formatWeekLabel', () => {
  // 8 Jun 2026 is a Monday (verified); its week ends Sun 14 Jun.
  it('same-month week: "8 – 14 June 2026"', () => {
    expect(formatWeekLabel(new Date(2026, 5, 8))).toBe('8 – 14 June 2026')
  })

  // 29 Jun 2026 is a Monday (verified); its week ends Sun 5 Jul.
  it('cross-month week: "29 June – 5 July 2026"', () => {
    expect(formatWeekLabel(new Date(2026, 5, 29))).toBe('29 June – 5 July 2026')
  })

  // 28 Dec 2026 is a Monday (verified); its week ends Sun 3 Jan 2027.
  it('cross-year week: "28 December 2026 – 3 January 2027"', () => {
    expect(formatWeekLabel(new Date(2026, 11, 28))).toBe('28 December 2026 – 3 January 2027')
  })
})

// ─── Integration: the trio replaces DayToDay's getWeekStart/addDays/weekLabel ─

describe('integration: week pipeline from an arbitrary date', () => {
  it('Wed 10 Jun 2026 → Monday-first week 8–14 Jun, labelled and enumerated', () => {
    const weekStart = getMondayWeekStart(new Date(2026, 5, 10, 17, 5))
    expect(ymd(weekStart)).toEqual([2026, 5, 8])

    const days = getWeekDays(weekStart)
    expect(ymd(days[6])).toEqual([2026, 5, 14]) // the Sunday column

    expect(formatWeekLabel(weekStart)).toBe('8 – 14 June 2026')

    // Week navigation as DayToDay does it: ±7 calendar days.
    expect(ymd(addDays(weekStart, 7))).toEqual([2026, 5, 15])
    expect(ymd(addDays(weekStart, -7))).toEqual([2026, 5, 1])
  })
})
