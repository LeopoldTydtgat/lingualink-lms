import { describe, it, expect } from 'vitest'
import {
  localMidnightToUtc,
  getMonthRangeInTz,
  getMonthKeyInTz,
  getDayRangeInTz,
  getDayKeyInTz,
} from './monthRange'
import { addDaysToDateKey, utcInstantToTzParts } from '@/lib/utils/timezone'

/**
 * DST regression net for the billing/dashboard date windows.
 *
 * localMidnightToUtc is the single definition of "local midnight" behind
 * getMonthRangeInTz (teacher + admin billing month), getDayRangeInTz (the
 * "Classes Today" bucket in both admin layouts) and the admin classes GET date
 * filter. It used to carry its own probe with a docstring claiming "two-pass"
 * while the code was single-pass: it read the offset at
 * midnight-reinterpreted-as-UTC and never re-derived it at the resulting
 * instant. Any boundary sitting on the far side of a DST transition from that
 * probe came out an hour off — and for Australia/Sydney a full calendar day off.
 *
 * 2026 transitions used here:
 *   Europe/Berlin, Europe/London   spring Sun 29 Mar 01:00Z / fall Sun 25 Oct 01:00Z
 *   America/New_York               spring Sun  8 Mar 07:00Z / fall Sun  1 Nov 06:00Z
 *   Australia/Sydney               spring Sun  4 Oct (03 Oct 16:00Z)
 *                                  fall   Sun  5 Apr (04 Apr 16:00Z)
 */

const HOUR = 3600_000
const ZONES = ['Europe/Berlin', 'Europe/London', 'America/New_York', 'Australia/Sydney']

// ─── localMidnightToUtc on transition dates ──────────────────────────────────

describe('localMidnightToUtc — DST transition dates', () => {
  it('northern-hemisphere transition dates resolve to true local midnight', () => {
    // Berlin: midnight on both transition dates is still on the PRE-transition
    // offset (the jump is at 02:00/03:00 local, hours after midnight).
    expect(localMidnightToUtc(2026, 3, 29, 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z')  // CET +1
    expect(localMidnightToUtc(2026, 10, 25, 'Europe/Berlin')).toBe('2026-10-24T22:00:00.000Z') // CEST +2

    expect(localMidnightToUtc(2026, 3, 29, 'Europe/London')).toBe('2026-03-29T00:00:00.000Z')  // GMT
    expect(localMidnightToUtc(2026, 10, 25, 'Europe/London')).toBe('2026-10-24T23:00:00.000Z') // BST +1

    expect(localMidnightToUtc(2026, 3, 8, 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')  // EST -5
    expect(localMidnightToUtc(2026, 11, 1, 'America/New_York')).toBe('2026-11-01T04:00:00.000Z') // EDT -4
  })

  it('Australia/Sydney spring forward: midnight is AEST, not the next day’s 23:00', () => {
    // THE Sydney regression. The old single-pass probe read the offset at
    // 2026-10-04T00:00Z, which is already 11:00 AEDT on Oct 4, applied -11h and
    // returned 2026-10-03T13:00:00Z — 23:00 on 3 October, the WRONG CALENDAR DAY.
    // Every "Classes Today" count and every month/day filter edge for a Sydney
    // profile started an hour into the previous day.
    expect(localMidnightToUtc(2026, 10, 4, 'Australia/Sydney')).toBe('2026-10-03T14:00:00.000Z')
    expect(localMidnightToUtc(2026, 10, 4, 'Australia/Sydney')).not.toBe('2026-10-03T13:00:00.000Z')
  })

  it('Australia/Sydney fall back: midnight is AEDT, not an hour into the day', () => {
    // Mirror failure in the other direction: the old probe read +10 at
    // 2026-04-05T00:00Z and returned 2026-04-04T14:00:00Z = 01:00 local, silently
    // dropping the first hour of 5 April from the day and month windows.
    expect(localMidnightToUtc(2026, 4, 5, 'Australia/Sydney')).toBe('2026-04-04T13:00:00.000Z')
    expect(localMidnightToUtc(2026, 4, 5, 'Australia/Sydney')).not.toBe('2026-04-04T14:00:00.000Z')
  })

  it('non-transition dates are unchanged in every zone', () => {
    expect(localMidnightToUtc(2026, 2, 1, 'Europe/Berlin')).toBe('2026-01-31T23:00:00.000Z')
    expect(localMidnightToUtc(2026, 8, 1, 'Europe/Berlin')).toBe('2026-07-31T22:00:00.000Z')
    expect(localMidnightToUtc(2026, 6, 15, 'Europe/London')).toBe('2026-06-14T23:00:00.000Z')
    expect(localMidnightToUtc(2026, 6, 15, 'America/New_York')).toBe('2026-06-15T04:00:00.000Z')
    expect(localMidnightToUtc(2026, 6, 15, 'Australia/Sydney')).toBe('2026-06-14T14:00:00.000Z')
    expect(localMidnightToUtc(2026, 6, 15, 'UTC')).toBe('2026-06-15T00:00:00.000Z')
  })
})

// ─── The invariant that catches every offset slip ────────────────────────────

describe('localMidnightToUtc — the returned instant always lands on the requested local date', () => {
  // Sweeps both transition weeks in all four zones. This is the assertion the
  // old implementation failed for Sydney on 2026-10-04.
  const WEEKS: [string, string][] = [
    ['Europe/Berlin', '2026-03-23'], ['Europe/Berlin', '2026-10-19'],
    ['Europe/London', '2026-03-23'], ['Europe/London', '2026-10-19'],
    ['America/New_York', '2026-03-02'], ['America/New_York', '2026-10-26'],
    ['Australia/Sydney', '2026-09-28'], ['Australia/Sydney', '2026-03-30'],
  ]

  it('local date of the boundary matches the date asked for, every day of both transition weeks', () => {
    for (const [tz, monday] of WEEKS) {
      for (let i = 0; i < 7; i++) {
        const key = addDaysToDateKey(monday, i)
        const [y, m, d] = key.split('-').map(Number)
        const iso = localMidnightToUtc(y, m, d, tz)
        expect(getDayKeyInTz(new Date(iso), tz), `${tz} ${key}`).toBe(key)
      }
    }
  })

  it('consecutive local midnights are strictly increasing and 23h / 24h / 25h apart', () => {
    for (const [tz, monday] of WEEKS) {
      const edges = Array.from({ length: 8 }, (_, i) => {
        const [y, m, d] = addDaysToDateKey(monday, i).split('-').map(Number)
        return new Date(localMidnightToUtc(y, m, d, tz)).getTime()
      })
      const spans = edges.slice(1).map((v, i) => (v - edges[i]) / HOUR)
      for (const s of spans) expect([23, 24, 25], `${tz} ${monday}`).toContain(s)
      // Exactly one short/long day per transition week; the rest are 24h.
      expect(spans.filter((s) => s !== 24), `${tz} ${monday}`).toHaveLength(1)
      // The week itself is 167h (spring) or 169h (fall) — never 168.
      expect([167, 169], `${tz} ${monday}`).toContain(spans.reduce((a, b) => a + b, 0))
    }
  })
})

// ─── Zones whose DST jump lands on midnight itself ───────────────────────────

describe('localMidnightToUtc — zones with no local midnight on the transition date', () => {
  it('returns the first instant of that local date (00:00 or, if skipped, 01:00) — never the previous date', () => {
    // A handful of zones move the clock at 00:00 local, so their spring-forward
    // date has no midnight at all. The documented gap contract shifts FORWARD, so
    // the boundary is the first instant that date actually has. Asserted as a
    // property rather than a hardcoded instant, because which of these zones
    // still has a midnight jump varies with the tzdata bundled in ICU.
    // All three verified against this runtime's tzdata to genuinely have NO local
    // 00:00 on the listed date (scanned the surrounding 28h minute by minute).
    // America/Sao_Paulo was dropped from this list: Brazil abolished DST in 2019,
    // so it has no gap and the case was inert.
    const CASES: [string, string][] = [
      ['America/Santiago', '2026-09-06'],
      ['America/Havana', '2026-03-08'],
      ['Asia/Beirut', '2026-03-29'],
    ]
    for (const [tz, key] of CASES) {
      const [y, m, d] = key.split('-').map(Number)
      const iso = localMidnightToUtc(y, m, d, tz)
      const p = utcInstantToTzParts(iso, tz)
      const gotKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
      expect(gotKey, `${tz} ${key}`).toBe(key)
      expect(p.minute, `${tz} ${key}`).toBe(0)
      expect([0, 1], `${tz} ${key}`).toContain(p.hour)
    }
  })
})

// ─── getMonthRangeInTz ───────────────────────────────────────────────────────

describe('getMonthRangeInTz — months containing a DST transition', () => {
  const midMonth = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 15, 12, 0, 0))

  it('a month losing an hour is 743h and one gaining an hour is 745h / 721h', () => {
    const span = (y: number, m: number, tz: string) => {
      const r = getMonthRangeInTz(midMonth(y, m), tz)
      return (new Date(r.endUtc).getTime() - new Date(r.startUtc).getTime()) / HOUR
    }
    expect(span(2026, 3, 'Europe/Berlin')).toBe(743)      // 31 days - 1h
    expect(span(2026, 10, 'Europe/Berlin')).toBe(745)     // 31 days + 1h
    expect(span(2026, 3, 'America/New_York')).toBe(743)
    expect(span(2026, 11, 'America/New_York')).toBe(721)  // 30 days + 1h
    expect(span(2026, 10, 'Australia/Sydney')).toBe(743)  // spring forward
    expect(span(2026, 4, 'Australia/Sydney')).toBe(721)   // fall back
    expect(span(2026, 6, 'Europe/Berlin')).toBe(720)      // plain 30-day month
  })

  it('exact boundaries for the Sydney transition months', () => {
    expect(getMonthRangeInTz(midMonth(2026, 10), 'Australia/Sydney')).toEqual({
      startUtc: '2026-09-30T14:00:00.000Z',   // 1 Oct 00:00 AEST
      endUtc: '2026-10-31T13:00:00.000Z',     // 1 Nov 00:00 AEDT
      monthKey: '2026-10-01',
    })
    expect(getMonthRangeInTz(midMonth(2026, 4), 'Australia/Sydney')).toEqual({
      startUtc: '2026-03-31T13:00:00.000Z',   // 1 Apr 00:00 AEDT
      endUtc: '2026-04-30T14:00:00.000Z',     // 1 May 00:00 AEST
      monthKey: '2026-04-01',
    })
  })

  // NOTE: an "a.endUtc === b.startUtc" contiguity check is TAUTOLOGICAL here and
  // was deliberately removed. getMonthRangeInTz computes endUtc as
  // localMidnightToUtc(nextYear, nextMonth, 1, tz) (monthRange.ts:63) and the next
  // month's startUtc as localMidnightToUtc(year, month, 1, tz) (monthRange.ts:62) —
  // literally the same three arguments. It compares f(x) to f(x) and can only ever
  // prove the function is pure. The invariant that actually protects the money is
  // the key-vs-range agreement below.

  it('THE MONEY INVARIANT: a lesson is inside the month range iff it keys to that month', () => {
    // Two different mechanisms decide which billing month a lesson belongs to:
    //   - the teacher billing page buckets by KEY, getMonthKeyInTz (pure Intl)
    //     — (dashboard)/billing/page.tsx:122
    //   - the layout widget and admin billing filter by RANGE, getMonthRangeInTz
    //     -> localMidnightToUtc -> wallTimeToUtcMs
    //     — (dashboard)/layout.tsx:128, BillingAdminClient.tsx:464
    // If they ever disagree, the same teacher's earnings differ between two
    // screens. Probe both sides of every month boundary to the minute.
    for (const tz of [...ZONES, 'Pacific/Auckland', 'Pacific/Chatham', 'Australia/Lord_Howe']) {
      for (let y = 2026; y <= 2030; y++) {
        for (let m = 1; m <= 12; m++) {
          const r = getMonthRangeInTz(midMonth(y, m), tz)
          const start = new Date(r.startUtc).getTime()
          const end = new Date(r.endUtc).getTime()
          for (const [instant, inside] of [
            [start - 60_000, false], [start, true],
            [end - 60_000, true], [end, false],
          ] as [number, boolean][]) {
            const keysToThisMonth = getMonthKeyInTz(new Date(instant), tz) === r.monthKey
            const inRange = instant >= start && instant < end
            expect(inRange, `${tz} ${r.monthKey} @ ${new Date(instant).toISOString()}`).toBe(inside)
            expect(keysToThisMonth, `${tz} ${r.monthKey} @ ${new Date(instant).toISOString()}`).toBe(inRange)
          }
        }
      }
    }
  })

  it('month boundaries that the single-pass probe actually got wrong', () => {
    // The ONLY boundaries where old and new differ are the ones where the 1st of a
    // month is itself a DST-transition date. In 2024-2036 that never happens for any
    // European or American zone — it is exclusively a +9:30..+13:45 phenomenon, which
    // is why a 2026-only test suite cannot see this bug at month granularity.
    // Old results are noted per case; each is off by the DST delta.
    expect(getMonthRangeInTz(new Date(Date.UTC(2028, 9, 15, 12)), 'Australia/Sydney').startUtc)
      .toBe('2028-09-30T14:00:00.000Z')   // old: 2028-09-30T13:00:00.000Z (wrong local DAY)
    expect(getMonthRangeInTz(new Date(Date.UTC(2029, 3, 15, 12)), 'Australia/Sydney').startUtc)
      .toBe('2029-03-31T13:00:00.000Z')   // old: 2029-03-31T14:00:00.000Z
    expect(getMonthRangeInTz(new Date(Date.UTC(2029, 3, 15, 12)), 'Pacific/Auckland').startUtc)
      .toBe('2029-03-31T11:00:00.000Z')   // old: 2029-03-31T12:00:00.000Z
    // Australia/Lord_Howe has a 30-MINUTE DST delta, so its error was 30 min, not 60.
    expect(getMonthRangeInTz(new Date(Date.UTC(2028, 9, 15, 12)), 'Australia/Lord_Howe').startUtc)
      .toBe('2028-09-30T13:30:00.000Z')   // old: 2028-09-30T13:00:00.000Z
  })
})

// ─── getDayRangeInTz ─────────────────────────────────────────────────────────

describe('getDayRangeInTz — days containing a DST transition', () => {
  // A midday instant inside the target local day, hardcoded so the test never
  // leans on the helper it is checking.
  const CASES: [string, string, string, number][] = [
    ['Europe/Berlin', '2026-03-29T10:00:00Z', '2026-03-29', 23],
    ['Europe/Berlin', '2026-10-25T11:00:00Z', '2026-10-25', 25],
    ['Europe/London', '2026-03-29T11:00:00Z', '2026-03-29', 23],
    ['Europe/London', '2026-10-25T12:00:00Z', '2026-10-25', 25],
    ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08', 23],
    ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01', 25],
    ['Australia/Sydney', '2026-10-04T01:00:00Z', '2026-10-04', 23],
    ['Australia/Sydney', '2026-04-05T02:00:00Z', '2026-04-05', 25],
  ]

  it('spring-forward days are 23h, fall-back days 25h, and both start on the right local date', () => {
    for (const [tz, midday, key, hours] of CASES) {
      const r = getDayRangeInTz(new Date(midday), tz)
      const label = `${tz} ${key}`
      expect((new Date(r.endUtc).getTime() - new Date(r.startUtc).getTime()) / HOUR, label).toBe(hours)
      expect(getDayKeyInTz(new Date(r.startUtc), tz), label).toBe(key)
      // The requested instant must sit inside its own [start, end) window.
      expect(new Date(midday).getTime(), label).toBeGreaterThanOrEqual(new Date(r.startUtc).getTime())
      expect(new Date(midday).getTime(), label).toBeLessThan(new Date(r.endUtc).getTime())
    }
  })

  it('exact boundaries for the Sydney transition days', () => {
    expect(getDayRangeInTz(new Date('2026-10-04T01:00:00Z'), 'Australia/Sydney')).toEqual({
      startUtc: '2026-10-03T14:00:00.000Z',   // 4 Oct 00:00 AEST
      endUtc: '2026-10-04T13:00:00.000Z',     // 5 Oct 00:00 AEDT
    })
    expect(getDayRangeInTz(new Date('2026-04-05T02:00:00Z'), 'Australia/Sydney')).toEqual({
      startUtc: '2026-04-04T13:00:00.000Z',   // 5 Apr 00:00 AEDT
      endUtc: '2026-04-05T14:00:00.000Z',     // 6 Apr 00:00 AEST
    })
  })
})
