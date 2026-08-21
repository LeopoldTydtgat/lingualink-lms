import { describe, it, expect } from 'vitest'
import {
  getWeekColumnKeys,
  buildInstantSet,
  getValidStartsByColumn,
  collapseEmptyBands,
  buildRowAxis,
  getVisibleColumns,
  buildCellMaps,
  snapToValidStart,
  type SlotsResponse,
  type GridStartSlot,
} from './bookingWeekGrid'
import { utcInstantToTzParts } from '@/lib/utils/timezone'

/**
 * BOOK-1 Stage A regression net for the single-page week-grid helpers.
 *
 * The bug classes pinned here:
 * - columns derived from response keys instead of weekStartKey (the NEW324
 *   day-8 continuation key must never paint a phantom 8th column);
 * - 60/90-min consecutive runs crossing student-local midnight on the LAST
 *   column, whose continuation instants live only under the day-8 key;
 * - rows keyed by instant instead of student-local wall clock, which splits
 *   one visual row in two on a DST-transition week;
 * - mid-run continuation rows (valid inside a run, a valid start nowhere)
 *   collapsed out of the band list, swallowing the selected-run highlight;
 * - CAL2: two distinct UTC instants sharing one wall-clock row on a DST
 *   fall-back day, where last-write-wins silently dropped the earlier
 *   instant so it could never be booked;
 * - a time axis derived from BOOKABLE slots only, which resized the grid as
 *   the student switched duration and left no room for the blocked cells;
 * - a tap on a free-but-not-a-valid-start tail slot doing nothing, instead of
 *   snapping back to the run that ends on it.
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

// A single already-flagged grid slot, as getValidStartsByColumn would emit it.
// `available` defaults to `bookable`: a slot that can start a run is free by
// definition, and the interesting free-but-not-a-start case is passed
// explicitly where a test needs it.
function gridSlot(ms: number, bookable = true, available = bookable): GridStartSlot {
  return { startIso: iso(ms), bookable, available }
}

// FIXTURE GUARD ONLY — never an expected value. Recomputing the row key here
// and asserting an expectation against it would assert the implementation
// against itself; expectations below are always literal row numbers.
function rowKeyOf(ms: number, tz: string): number {
  const parts = utcInstantToTzParts(new Date(ms), tz)
  return parts.hour * 60 + parts.minute
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
    // The grey cell survives, flagged non-bookable AND non-available.
    expect(byColumn['2026-06-03']).toEqual([
      { startIso: iso(wedSlot), bookable: false, available: false },
    ])
    // The raw API flag rides through untouched on the bookable slots too.
    expect(byColumn['2026-06-01'].map((s) => s.available)).toEqual([true, true, true])
    expect(byColumn['2026-06-02'][0].available).toBe(true)
    // Columns the response never mentioned come back as empty arrays.
    expect(byColumn['2026-06-07']).toEqual([])
  })

  it('60 min: the last slot of a 3-run and an isolated slot stop being bookable starts', () => {
    const byColumn = getValidStartsByColumn(columns, response, instantSet, 60)
    // 09:00 (09:00+09:30) and 09:30 (09:30+10:00) fit; 10:00 has no 10:30.
    expect(byColumn['2026-06-01'].map((s) => s.bookable)).toEqual([true, true, false])
    expect(byColumn['2026-06-02'][0].bookable).toBe(false)
    // available is RAW: losing start-validity at 60 min must not flip it —
    // free-but-not-a-start is exactly the cell snapToValidStart exists for.
    expect(byColumn['2026-06-01'].map((s) => s.available)).toEqual([true, true, true])
    expect(byColumn['2026-06-02'][0].available).toBe(true)
    expect(byColumn['2026-06-03'][0].available).toBe(false)
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
    expect(byColumn['2026-06-07']).toEqual([
      { startIso: iso(sunLate), bookable: true, available: true },
    ])
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
    expect(collapseEmptyBands(byColumn, UTC, 30)).toEqual([[540, 570], [900]])
  })

  it('rows with only non-bookable slots collapse unless they continue a run', () => {
    // At 60 min the isolated 15:00 slot is never a start NOR inside any run,
    // so its row vanishes; 09:30 is no start either (no 10:00) but survives
    // as the continuation row of the 09:00 start.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 2),
      '2026-06-02': run(Date.UTC(2026, 5, 2, 15, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    expect(collapseEmptyBands(byColumn, UTC, 60)).toEqual([[540, 570]])
  })

  it('deduplicates the same wall-time row across columns', () => {
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 1),
      '2026-06-03': run(Date.UTC(2026, 5, 3, 9, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(collapseEmptyBands(byColumn, UTC, 30)).toEqual([[540]])
  })

  it('90 min: mid-run rows that are a valid start nowhere still get rows, in the run band', () => {
    // Mon 15:30–17:00 (3 slots): only 15:30 is a valid 90-min start, so
    // 16:00/16:30 are pure continuations — before the durationMinutes rule
    // they collapsed away and the selected run painted only its start cell.
    // Tue 09:00–10:30 is a second, disjoint band with the same shape.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 15, 30), 3),
      '2026-06-02': run(Date.UTC(2026, 5, 2, 9, 0), 3),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 90)
    // Sanity: exactly one bookable start per day.
    expect(byColumn['2026-06-01'].map((s) => s.bookable)).toEqual([true, false, false])
    expect(byColumn['2026-06-02'].map((s) => s.bookable)).toEqual([true, false, false])
    expect(collapseEmptyBands(byColumn, UTC, 90)).toEqual([
      [540, 570, 600],
      [930, 960, 990],
    ])
  })

  it('30 min: behaviour unchanged — no continuation rows beyond the start', () => {
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 15, 30), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(collapseEmptyBands(byColumn, UTC, 30)).toEqual([[930]])
  })

  it('cross-midnight run: continuation rows land early-morning, never merged across midnight', () => {
    // Tue 23:30 + Wed 00:00: the only 60-min start is 23:30; its 00:00
    // continuation becomes wall row 0, which sorts FIRST and stays in its
    // own band — 23:30 → 00:00 adjacency is deliberately not contiguous.
    const response: SlotsResponse = {
      '2026-06-02': run(Date.UTC(2026, 5, 2, 23, 30), 1),
      '2026-06-03': run(Date.UTC(2026, 5, 3, 0, 0), 1),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    expect(collapseEmptyBands(byColumn, UTC, 60)).toEqual([[0], [1410]])
  })

  it('90 min via day-8 extras: continuation rows come from start arithmetic, not response bucketing', () => {
    // Sun 23:30 validates through day-8 continuations that are never columns:
    // rows 00:00/00:30 must still appear (contiguous, before the 23:30 band)
    // because they derive from the START instant + k·30min, not from any
    // column's own slots.
    const response: SlotsResponse = {
      '2026-06-07': run(Date.UTC(2026, 5, 7, 23, 30), 1),
      '2026-06-08': run(Date.UTC(2026, 5, 8, 0, 0), 2),
    }
    const columns = getWeekColumnKeys(WEEK)
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 90)
    expect(collapseEmptyBands(byColumn, UTC, 90)).toEqual([[0, 30], [1410]])
  })
})

describe('buildRowAxis', () => {
  const columns = getWeekColumnKeys(WEEK)

  it('fills the gap rows between two availability bands, continuously', () => {
    // Mon 09:00+09:30 and Tue 15:00 — rows 540/570 and 900. The axis is the
    // whole ruler between them, every 30-min row included, where
    // collapseEmptyBands returns the two bands with the gap cut out.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 2),
      '2026-06-02': run(Date.UTC(2026, 5, 2, 15, 0), 1),
    }
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(buildRowAxis(byColumn, UTC)).toEqual([
      540, 570, 600, 630, 660, 690, 720, 750, 780, 810, 840, 870, 900,
    ])
    // The same input, collapsed: the gap rows are exactly what differs.
    expect(collapseEmptyBands(byColumn, UTC, 30)).toEqual([[540, 570], [900]])

    // Duration-independent by construction — the axis reads every slot's row
    // and never the bookable flag. Bookability really does move underneath
    // it here (2 columns → 1 → none), and the axis still does not budge.
    const sixty = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    const ninety = getValidStartsByColumn(columns, response, buildInstantSet(response), 90)
    expect(getVisibleColumns(byColumn)).toEqual(['2026-06-01', '2026-06-02'])
    expect(getVisibleColumns(sixty)).toEqual(['2026-06-01'])
    expect(getVisibleColumns(ninety)).toEqual([])
    expect(buildRowAxis(sixty, UTC)).toEqual(buildRowAxis(byColumn, UTC))
    expect(buildRowAxis(ninety, UTC)).toEqual(buildRowAxis(byColumn, UTC))
  })

  it('empty input returns []', () => {
    expect(buildRowAxis({}, UTC)).toEqual([])
    // Seven real columns, every one an empty array — still no rows at all.
    const byColumn = getValidStartsByColumn(columns, {}, new Set(), 30)
    expect(Object.keys(byColumn)).toHaveLength(7)
    expect(buildRowAxis(byColumn, UTC)).toEqual([])
  })

  it('unavailable slots contribute rows — the axis sizes the grey cells too', () => {
    // Mon 09:00 available, Wed 11:00 blocked. The blocked cell still has to
    // render, so row 660 must exist and the axis must stretch to reach it;
    // collapseEmptyBands, which answers a different question, drops it.
    const response: SlotsResponse = {
      '2026-06-01': run(Date.UTC(2026, 5, 1, 9, 0), 1),
      '2026-06-03': run(Date.UTC(2026, 5, 3, 11, 0), 1, false),
    }
    const byColumn = getValidStartsByColumn(columns, response, buildInstantSet(response), 30)
    expect(byColumn['2026-06-03'][0]).toEqual({
      startIso: iso(Date.UTC(2026, 5, 3, 11, 0)),
      bookable: false,
      available: false,
    })
    expect(buildRowAxis(byColumn, UTC)).toEqual([540, 570, 600, 630, 660])
    expect(collapseEmptyBands(byColumn, UTC, 30)).toEqual([[540]])
  })

  it('DST fall-back: the duplicated wall hour is ONE row key, not two', () => {
    // America/New_York 2026-11-01: wall 01:00 happens at 05:00Z (EDT, UTC-4)
    // and again at 06:00Z (EST, UTC-5). Two instants, one visual row — the
    // axis must not grow a second row for the repeat.
    const NY = 'America/New_York'
    const EDT_ONE_AM = Date.UTC(2026, 10, 1, 5, 0)
    const EST_ONE_AM = Date.UTC(2026, 10, 1, 6, 0)
    // Fixture guard: both instants really do read 01:00 in New York that day.
    expect(rowKeyOf(EDT_ONE_AM, NY)).toBe(60)
    expect(rowKeyOf(EST_ONE_AM, NY)).toBe(60)
    expect(EST_ONE_AM - EDT_ONE_AM).toBe(60 * 60 * 1000)

    const byColumn = { '2026-11-01': [gridSlot(EDT_ONE_AM), gridSlot(EST_ONE_AM)] }
    expect(buildRowAxis(byColumn, NY)).toEqual([60])
    // Read in UTC the very same two instants are two rows an hour apart —
    // proof the collapse above is the timezone's doing, not blind dedup.
    expect(buildRowAxis(byColumn, UTC)).toEqual([300, 330, 360])
  })

  it('DST spring-forward: the skipped wall hour is emitted as gap rows', () => {
    // Europe/Madrid 2026-03-29: 02:00 CET jumps to 03:00 CEST, so wall 02:00
    // and 02:30 never happen. 00:30Z reads 01:30 (row 90) and 01:00Z reads
    // 03:00 (row 180) — 30 real minutes apart, three rows apart on the wall
    // clock. The axis is continuous by definition, so the two impossible rows
    // come back as gaps for the cell maps to leave empty.
    const MADRID = 'Europe/Madrid'
    const beforeJump = Date.UTC(2026, 2, 29, 0, 30)
    const afterJump = Date.UTC(2026, 2, 29, 1, 0)
    expect(rowKeyOf(beforeJump, MADRID)).toBe(90)
    expect(rowKeyOf(afterJump, MADRID)).toBe(180)
    expect(afterJump - beforeJump).toBe(HALF_HOUR)

    const byColumn = { '2026-03-29': [gridSlot(beforeJump), gridSlot(afterJump)] }
    expect(buildRowAxis(byColumn, MADRID)).toEqual([90, 120, 150, 180])
  })

  it('an off-residue row key gets its own row instead of being stepped over', () => {
    // A slot at wall 09:17 (row 557) is not congruent to a 30-min ruler
    // stepped from 09:00. Stepping alone would emit 540/570 only, and the
    // 09:17 cell — which buildCellMaps keys under 557 — would have had no row
    // to render on: invisible, and therefore unbookable. The union keeps it.
    const nineAm = Date.UTC(2026, 5, 1, 9, 0)
    const offResidue = Date.UTC(2026, 5, 1, 9, 17)
    const nineThirty = Date.UTC(2026, 5, 1, 9, 30)
    // Fixture guard: the odd slot really does read wall 09:17 = row 557.
    expect(rowKeyOf(offResidue, UTC)).toBe(557)

    const byColumn = {
      '2026-06-01': [gridSlot(nineAm), gridSlot(offResidue), gridSlot(nineThirty)],
    }
    const axis = buildRowAxis(byColumn, UTC)
    expect(axis).toContain(557)
    // The aligned rows all survive — the union adds, it never replaces.
    expect(axis).toContain(540)
    expect(axis).toContain(570)
    expect(axis).toEqual([540, 557, 570])
    // Strictly ascending, no duplicates.
    expect(new Set(axis).size).toBe(axis.length)
    for (let i = 1; i < axis.length; i++) {
      expect(axis[i]).toBeGreaterThan(axis[i - 1])
    }

    // Every cell key buildCellMaps produces has a row on the axis: the two
    // cannot disagree, because both key off utcInstantToTzParts wall minutes.
    const cellKeys = [
      ...(buildCellMaps(['2026-06-01'], byColumn, UTC).get('2026-06-01')?.keys() ?? []),
    ]
    expect(cellKeys).toEqual([540, 557, 570])
    for (const key of cellKeys) expect(axis).toContain(key)

    // Widen the span: the stepped ruler still supplies gap row 600 while 557
    // keeps its own row, and a ruler row never duplicates a collected key.
    const wider = {
      '2026-06-01': [
        gridSlot(nineAm),
        gridSlot(offResidue),
        gridSlot(nineThirty),
        gridSlot(Date.UTC(2026, 5, 1, 10, 30)),
      ],
    }
    expect(buildRowAxis(wider, UTC)).toEqual([540, 557, 570, 600, 630])
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
    expect(collapseEmptyBands(byColumn, MADRID, 30)).toEqual([[540, 570]])
    // And the uncollapsed axis is those same two rows, nothing wider: the
    // two offsets must not stretch the ruler.
    expect(buildRowAxis(byColumn, MADRID)).toEqual([540, 570])
  })

  it('a 60-min run on the transition day itself assembles from real instants', () => {
    const bySixty = getValidStartsByColumn(columns, response, buildInstantSet(response), 60)
    expect(bySixty['2026-03-29'].map((s) => s.bookable)).toEqual([true, false])
  })
})

describe('buildCellMaps (CAL2)', () => {
  // America/New_York falls back on 2026-11-01 at 02:00 EDT → 01:00 EST, so the
  // wall time 01:00 occurs TWICE: once at 05:00:00Z (EDT, UTC-4) and again at
  // 06:00:00Z (EST, UTC-5). Both land on grid row key 60.
  const NY = 'America/New_York'
  const FALLBACK_KEY = '2026-11-01'
  const EDT_ONE_AM = Date.UTC(2026, 10, 1, 5, 0)
  const EST_ONE_AM = Date.UTC(2026, 10, 1, 6, 0)
  const ROW_ONE_AM = 60

  // Fixture guard: assert against Intl that the two chosen instants really do
  // both read 01:00 on 2026-11-01 in New York, and really are an hour apart.
  // Called from every collision test so a wrong fixture fails loudly here
  // instead of quietly making the collision assertions vacuous.
  function assertFixtureIsTheDuplicatedHour() {
    for (const ms of [EDT_ONE_AM, EST_ONE_AM]) {
      const parts = utcInstantToTzParts(new Date(ms), NY)
      expect(parts.hour).toBe(1)
      expect(parts.minute).toBe(0)
      expect(parts.year).toBe(2026)
      expect(parts.month).toBe(11)
      expect(parts.day).toBe(1)
      expect(parts.hour * 60 + parts.minute).toBe(ROW_ONE_AM)
    }
    // Two genuinely distinct instants, one hour apart — not the same slot twice.
    expect(EST_ONE_AM - EDT_ONE_AM).toBe(60 * 60 * 1000)
  }

  it('fixture: both instants really are wall-clock 01:00 on the fall-back day', () => {
    assertFixtureIsTheDuplicatedHour()
  })

  it('fall-back collision: the EARLIER instant wins the cell (earlier fed first)', () => {
    assertFixtureIsTheDuplicatedHour()
    const cellMaps = buildCellMaps(
      [FALLBACK_KEY],
      { [FALLBACK_KEY]: [gridSlot(EDT_ONE_AM), gridSlot(EST_ONE_AM)] },
      NY,
    )
    const column = cellMaps.get(FALLBACK_KEY)
    expect(column?.get(ROW_ONE_AM)?.startIso).toBe(iso(EDT_ONE_AM))
    // One row key, one cell — never a duplicated row for the second instant.
    expect(column?.size).toBe(1)
  })

  it('fall-back collision: the EARLIER instant wins the cell (later fed first — order independent)', () => {
    assertFixtureIsTheDuplicatedHour()
    const cellMaps = buildCellMaps(
      [FALLBACK_KEY],
      { [FALLBACK_KEY]: [gridSlot(EST_ONE_AM), gridSlot(EDT_ONE_AM)] },
      NY,
    )
    const column = cellMaps.get(FALLBACK_KEY)
    expect(column?.get(ROW_ONE_AM)?.startIso).toBe(iso(EDT_ONE_AM))
    expect(column?.size).toBe(1)
  })

  it('non-transition day: keys and slots map 1:1 and hold the input slot objects', () => {
    // Mon 09:00/09:30/10:00 UTC → rows 540/570/600, one cell each.
    const slots = [
      gridSlot(Date.UTC(2026, 5, 1, 9, 0)),
      gridSlot(Date.UTC(2026, 5, 1, 9, 30)),
      gridSlot(Date.UTC(2026, 5, 1, 10, 0), false),
    ]
    const cellMaps = buildCellMaps(
      ['2026-06-01', '2026-06-02'],
      { '2026-06-01': slots, '2026-06-02': [] },
      UTC,
    )
    const column = cellMaps.get('2026-06-01')
    expect(column?.size).toBe(3)
    expect([...(column?.keys() ?? [])]).toEqual([540, 570, 600])
    // toBe, not toEqual: the exact input objects are stored, unwrapped.
    expect(column?.get(540)).toBe(slots[0])
    expect(column?.get(570)).toBe(slots[1])
    expect(column?.get(600)).toBe(slots[2])
    // A slot-less column still gets a map, empty — every row renders grey.
    expect(cellMaps.get('2026-06-02')?.size).toBe(0)
  })

  it('columns are isolated: the same wall minute in two columns keeps each column its own slot', () => {
    const monNine = Date.UTC(2026, 5, 1, 9, 0)
    const tueNine = Date.UTC(2026, 5, 2, 9, 0)
    const cellMaps = buildCellMaps(
      ['2026-06-01', '2026-06-02'],
      { '2026-06-01': [gridSlot(monNine)], '2026-06-02': [gridSlot(tueNine)] },
      UTC,
    )
    expect(cellMaps.get('2026-06-01')?.get(540)?.startIso).toBe(iso(monNine))
    expect(cellMaps.get('2026-06-02')?.get(540)?.startIso).toBe(iso(tueNine))
    // Later columns never overwrite earlier ones despite the shared row key.
    expect(cellMaps.get('2026-06-01')?.size).toBe(1)
    expect(cellMaps.get('2026-06-02')?.size).toBe(1)
  })
})

describe('snapToValidStart', () => {
  const columns = getWeekColumnKeys(WEEK)

  it('a tap on a valid start returns that same start — the LATEST covering one', () => {
    // Mon 09:00–10:30 (4 slots). At 60 min both 09:00 and 09:30 are valid
    // starts and both cover 09:30, so the k = 0 hit matters: tapping 09:30
    // must return 09:30, never walk back to the earlier 09:00.
    const base = Date.UTC(2026, 5, 1, 9, 0)
    const set = buildInstantSet({ '2026-06-01': run(base, 4) })
    expect(snapToValidStart(iso(base + HALF_HOUR), 2, set)).toBe(iso(base + HALF_HOUR))
    expect(snapToValidStart(iso(base), 2, set)).toBe(iso(base))
  })

  it('walks back one step when the tapped slot is the tail of the band', () => {
    // Mon 09:00+09:30 only. At 60 min 09:30 is free but not a valid start
    // (no 10:00), so the tap resolves to the run that ENDS on it.
    const base = Date.UTC(2026, 5, 1, 9, 0)
    const response: SlotsResponse = { '2026-06-01': run(base, 2) }
    const set = buildInstantSet(response)
    const byColumn = getValidStartsByColumn(columns, response, set, 60)
    // The tapped cell really is the free-but-not-a-start case, both flags.
    expect(byColumn['2026-06-01'][1]).toEqual({
      startIso: iso(base + HALF_HOUR),
      bookable: false,
      available: true,
    })
    expect(snapToValidStart(iso(base + HALF_HOUR), 2, set)).toBe(iso(base))
  })

  it('walks back two steps for a 90-min run', () => {
    // Mon 09:00–10:00 (3 slots): the only 90-min start is 09:00, so both
    // 09:30 (one step back) and 10:00 (two steps back) resolve to it.
    const base = Date.UTC(2026, 5, 1, 9, 0)
    const set = buildInstantSet({ '2026-06-01': run(base, 3) })
    expect(snapToValidStart(iso(base + 2 * HALF_HOUR), 3, set)).toBe(iso(base))
    expect(snapToValidStart(iso(base + HALF_HOUR), 3, set)).toBe(iso(base))
    expect(snapToValidStart(iso(base), 3, set)).toBe(iso(base))
    // The walk stops at slotsNeeded - 1 steps: tapping 11:00 tries 11:00,
    // 10:30 and 10:00 — none is a valid 90-min start — and never reaches
    // 09:00, so it fails closed rather than booking a run that misses the tap.
    expect(snapToValidStart(iso(base + 4 * HALF_HOUR), 3, set)).toBeNull()
  })

  it('returns null when no valid start covers the tapped slot', () => {
    // An isolated 15:00 slot: at 60 min neither 15:00 (no 15:30) nor 14:30
    // (absent from the set) is a valid start, so the tap must fail closed.
    const isolated = Date.UTC(2026, 5, 2, 15, 0)
    const set = buildInstantSet({ '2026-06-02': run(isolated, 1) })
    expect(snapToValidStart(iso(isolated), 2, set)).toBeNull()
    // An instant that is not in the set at all is equally closed.
    expect(snapToValidStart(iso(Date.UTC(2026, 5, 2, 20, 0)), 2, set)).toBeNull()
    // At 30 min the same isolated slot IS its own valid start.
    expect(snapToValidStart(iso(isolated), 1, set)).toBe(iso(isolated))
    // Blocked slots never enter the instant set, so they never snap anywhere.
    const blocked = buildInstantSet({ '2026-06-02': run(isolated, 2, false) })
    expect(blocked.size).toBe(0)
    expect(snapToValidStart(iso(isolated), 1, blocked)).toBeNull()
  })

  it('cross-midnight: resolves by pure instant math, across columns and the day-8 key', () => {
    // Sun 23:30 + day-8 Mon 00:00/00:30. Tapping the 00:30 continuation — a
    // slot filed under a key that is never a column — must still resolve to
    // the Sunday 23:30 start of the 90-min run covering it.
    const sunLate = Date.UTC(2026, 5, 7, 23, 30)
    const daySet = buildInstantSet({
      '2026-06-07': run(sunLate, 1),
      '2026-06-08': run(Date.UTC(2026, 5, 8, 0, 0), 2),
    })
    expect(snapToValidStart(iso(sunLate + 2 * HALF_HOUR), 3, daySet)).toBe(iso(sunLate))

    // The 60-min case one column over: Tue 23:30 + Wed 00:00, tap Wed 00:00.
    const tueLate = Date.UTC(2026, 5, 2, 23, 30)
    const midnightSet = buildInstantSet({
      '2026-06-02': run(tueLate, 1),
      '2026-06-03': run(Date.UTC(2026, 5, 3, 0, 0), 1),
    })
    expect(snapToValidStart(iso(tueLate + HALF_HOUR), 2, midnightSet)).toBe(iso(tueLate))
  })

  it('DST spring-forward: 30 min of elapsed time is 30 min, whatever the wall clock does', () => {
    // Europe/Madrid 2026-03-29: 00:30Z reads 01:30 CET, 01:00Z reads 03:00
    // CEST — consecutive instants across an apparent 90-min wall jump.
    // Snapping is instant math, so tapping the 03:00 cell walks back to the
    // 01:30 start exactly as it would on any ordinary day.
    const MADRID = 'Europe/Madrid'
    const beforeJump = Date.UTC(2026, 2, 29, 0, 30)
    const afterJump = Date.UTC(2026, 2, 29, 1, 0)
    expect(rowKeyOf(beforeJump, MADRID)).toBe(90)
    expect(rowKeyOf(afterJump, MADRID)).toBe(180)
    const set = buildInstantSet({ '2026-03-29': run(beforeJump, 2) })
    expect(set.has(afterJump)).toBe(true)
    expect(snapToValidStart(iso(afterJump), 2, set)).toBe(iso(beforeJump))
  })
})
