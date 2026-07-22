import { describe, it, expect } from 'vitest'
import {
  getWeekColumnKeys,
  buildInstantSet,
  getValidStartsByColumn,
  collapseEmptyBands,
  getVisibleColumns,
  type SlotsResponse,
} from './bookingWeekGrid'

/**
 * BOOK-1 Stage A regression net for the single-page week-grid helpers.
 *
 * The bug classes pinned here:
 * - columns derived from response keys instead of weekStartKey (the NEW324
 *   day-8 continuation key must never paint a phantom 8th column);
 * - 60/90-min consecutive runs crossing student-local midnight on the LAST
 *   column, whose continuation instants live only under the day-8 key;
 * - rows keyed by instant instead of student-local wall clock, which splits
 *   one visual row in two on a DST-transition week.
 *
 * Instants are built via Date.UTC only — no toISOString-derived local dates.
 */

const HALF_HOUR = 30 * 60 * 1000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// n consecutive 30-min slots from a base ms, all with the same availability.
function run(baseMs: number, count: number, available = true) {
  return Array.from({ length: count }, (_, i) => ({
    startIso: iso(baseMs + i * HALF_HOUR),
    available,
  }))
}

// 2026-06-01 is a Monday; UTC student keeps date keys == UTC dates.
const WEEK = '2026-06-01'
const UTC = 'UTC'

describe('getWeekColumnKeys', () => {
  it('returns the 7 consecutive date keys from the Monday key', () => {
    expect(getWeekColumnKeys(WEEK)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
    ])
  })

  it('rolls over month boundaries by calendar arithmetic', () => {
    expect(getWeekColumnKeys('2026-06-29')).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ])
  })
})

describe('normal week', () => {
  // Mon 09:00–10:30 available (3 slots), Tue 14:00 available (isolated),
  // Wed 11:00 present but unavailable (booked/blocked — grey cell).
  const monBase = Date.UTC(2026, 5, 1, 9, 0)
  const tueSlot = Date.UTC(2026, 5, 2, 14, 0)
  const wedSlot = Date.UTC(2026, 5, 3, 11, 0)
  const response: SlotsResponse = {
    '2026-06-01': run(monBase, 3),
    '2026-06-02': run(tueSlot, 1),
    '2026-06-03': run(wedSlot, 1, false),
  }
  const columns = getWeekColumnKeys(WEEK)
  const instantSet = buildInstantSet(response)

  it('instant set holds only available instants', () => {
    expect(instantSet.size).toBe(4)
    expect(instantSet.has(wedSlot)).toBe(false)
  })

  it('30 min: every available slot is a bookable start; unavailable is kept flagged false', () => {
    const byColumn = getValidStartsByColumn(columns, response, instantSet, 30)
    expect(byColumn['2026-06-01'].map((s) => s.bookable)).toEqual([true, true, true])
    expect(byColumn['2026-06-02'][0].bookable).toBe(true)
    // The grey cell survives, flagged non-bookable.
    expect(byColumn['2026-06-03']).toEqual([{ startIso: iso(wedSlot), bookable: false }])
    // Columns the response never mentioned come back as empty arrays.
    expect(byColumn['2026-06-07']).toEqual([])
  })

  it('60 min: the last slot of a 3-run and an isolated slot stop being bookable starts', () => {
    const byColumn = getValidStartsByColumn(columns, response, instantSet, 60)
    // 09:00 (09:00+09:30) and 09:30 (09:30+10:00) fit; 10:00 has no 10:30.
    expect(byColumn['2026-06-01'].map((s) => s.bookable)).toEqual([true, true, false])
    expect(byColumn['2026-06-02'][0].bookable).toBe(false)
  })
})

describe('day-8 extras (NEW324)', () => {
  // Sunday (last column) 23:30 available; the two continuation slots
  // 00:00/00:30 fall on Monday of the NEXT week and arrive under the day-8
  // key '2026-06-08'.
  const sunLate = Date.UTC(2026, 5, 7, 23, 30)
  const response: SlotsResponse = {
    '2026-06-07': run(sunLate, 1),
    '2026-06-08': run(Date.UTC(2026, 5, 8, 0, 0), 2),
  }
  const columns = getWeekColumnKeys(WEEK)
  const instantSet = buildInstantSet(response)

  it('day-8 instants count in the instant set', () => {
    expect(instantSet.size).toBe(3)
    expect(instantSet.has(Date.UTC(2026, 5, 8, 0, 30))).toBe(true)
  })

  it('the day-8 key is never a column', () => {
    expect(columns).not.toContain('2026-06-08')
    const byColumn = getValidStartsByColumn(columns, response, instantSet, 90)
    expect(Object.keys(byColumn)).toEqual(columns)
    expect(byColumn['2026-06-08']).toBeUndefined()
    expect(getVisibleColumns(byColumn)).toEqual(['2026-06-07'])
  })

  it('90 min starting 23:30 on the last column assembles across the day-8 extras', () => {
    const byColumn = getValidStartsByColumn(columns, response, instantSet, 90)
    expect(byColumn['2026-06-07']).toEqual([{ startIso: iso(sunLate), bookable: true }])
  })

  it('without the day-8 extras the same 90-min start fails closed', () => {
    const truncated: SlotsResponse = { '2026-06-07': run(sunLate, 1) }
    const byColumn = getValidStartsByColumn(columns, truncated, buildInstantSet(truncated), 90)
    expect(byColumn['2026-06-07'][0].bookable).toBe(false)
  })
})

describe('cross-midnight inside the week (not day-8)', () => {
  // Tue 23:30 + Wed 00:00 available: since NEW317 the continuation slot is
  // bucketed under Wednesday, so a within-column walk could never assemble
  // the 60-min run — the week-wide instant set must.
  const tueLate = Date.UTC(2026, 5, 2, 23, 30)
  const wedEarly = Date.UTC(2026, 5, 3, 0, 0)
  const response: SlotsResponse = {
    '2026-06-02': run(tueLate, 1),
    '2026-06-03': run(wedEarly, 1),
  }
  const columns = getWeekColumnKeys(WEEK)
  const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)

  it('the 23:30 start is bookable via the next column continuation', () => {
    expect(byColumn['2026-06-02'][0].bookable).toBe(true)
  })

  it('the 00:00 continuation itself is not a 60-min start (no 00:30)', () => {
    expect(byColumn['2026-06-03'][0].bookable).toBe(false)
  })
})

describe('getVisibleColumns — empty days hidden', () => {
  it('drops columns with no slots and columns with only non-bookable slots', () => {
    const mon = Date.UTC(2026, 5, 1, 9, 0)
    const thuBlocked = Date.UTC(2026, 5, 4, 9, 0)
    const response: SlotsResponse = {
      '2026-06-01': run(mon, 2),
      '2026-06-04': run(thuBlocked, 1, false), // grey-only day
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(getVisibleColumns(byColumn)).toEqual(['2026-06-01'])
  })

  it('preserves chronological order across multiple visible days', () => {
    const response: SlotsResponse = {
      '2026-06-02': run(Date.UTC(2026, 5, 2, 9, 0), 1),
      '2026-06-05': run(Date.UTC(2026, 5, 5, 9, 0), 1),
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(getVisibleColumns(byColumn)).toEqual(['2026-06-01', '2026-06-02', '2026-06-05'])
  })
})

describe('collapseEmptyBands', () => {
  it('collapses the empty gap between morning and afternoon into a band break', () => {
    // Mon 09:00+09:30 and Tue 15:00 — rows 540/570 contiguous, 900 separate.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 2),
      '2026-06-02': run(Date.UTC(2026, 5, 2, 15, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(collapseEmptyBands(byColumn, UTC)).toEqual([[540, 570], [900]])
  })

  it('rows with only non-bookable slots are collapsed away', () => {
    // At 60 min the isolated 15:00 slot is never a start, so its row vanishes.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 2),
      '2026-06-02': run(Date.UTC(2026, 5, 2, 15, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    // 09:00 is the only 60-min start (09:30 lacks 10:00).
    expect(collapseEmptyBands(byColumn, UTC)).toEqual([[540]])
  })

  it('deduplicates the same wall-time row across columns', () => {
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 1),
      '2026-06-03': run(Date.UTC(2026, 5, 3, 9, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(collapseEmptyBands(byColumn, UTC)).toEqual([[540]])
  })
})

describe('DST transition week (Europe/Madrid, spring forward 2026-03-29)', () => {
  // Week Mon 2026-03-23 … Sun 2026-03-29. Wed 09:00 is CET (= 08:00Z);
  // Sunday 09:00 is CEST after the clocks jump (= 07:00Z). Same visual row,
  // different UTC offsets — rows must key by student wall clock, not instant.
  const MADRID = 'Europe/Madrid'
  const DST_WEEK = '2026-03-23'
  const wedCet = Date.UTC(2026, 2, 25, 8, 0)
  const sunCest = Date.UTC(2026, 2, 29, 7, 0)
  const response: SlotsResponse = {
    '2026-03-25': run(wedCet, 2),
    '2026-03-29': run(sunCest, 2),
  }
  const columns = getWeekColumnKeys(DST_WEEK)
  const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)

  it('columns still span exactly the 7 requested dates', () => {
    expect(columns[0]).toBe('2026-03-23')
    expect(columns[6]).toBe('2026-03-29')
  })

  it('both sides of the transition land on the same 09:00/09:30 rows', () => {
    expect(collapseEmptyBands(byColumn, MADRID)).toEqual([[540, 570]])
  })

  it('a 60-min run on the transition day itself assembles from real instants', () => {
    const bySixty = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    expect(bySixty['2026-03-29'].map((s) => s.bookable)).toEqual([true, false])
  })
})
