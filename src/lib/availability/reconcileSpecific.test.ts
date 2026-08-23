import { describe, it, expect } from 'vitest'
import {
  reconcileSpecific,
  type ExistingSpecificRow,
  type NewSpecificRange,
} from './reconcileSpecific'

/**
 * Regression net for reconcile-before-write on timed 'specific' availability.
 *
 * The bug class: POST /api/teacher/availability only ever INSERTed specific
 * rows (its upsert conflict target is all-NULL for them), so overlapping drags
 * stacked invisible duplicates - one visible rectangle backed by N rows, a
 * delete that appeared to do nothing, and a green run permanently buried under
 * a co-extensive red one.
 *
 * Everything below is pure instant arithmetic on UTC instants built with
 * Date.UTC, so these tests are timezone-agnostic by construction: no wall-clock
 * frame, no local Date parts, no DST exposure.
 */

// Monday 24 August 2026, UTC. Only the offsets matter.
function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 24, hour, minute)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function row(
  id: string,
  startHour: number,
  endHour: number,
  isAvailable = true,
): ExistingSpecificRow {
  return { id, start_at: iso(at(startHour)), end_at: iso(at(endHour)), is_available: isAvailable }
}

function range(startHour: number, endHour: number, isAvailable = true): NewSpecificRange {
  return { startMs: at(startHour), endMs: at(endHour), isAvailable }
}

describe('reconcileSpecific', () => {
  it('no overlap -> nothing deleted, nothing written back', () => {
    const result = reconcileSpecific(range(10, 11), [row('a', 8, 9)])
    expect(result).toEqual({ deleteIds: [], remainders: [] })
  })

  it('exact match -> row deleted, no remainder', () => {
    const result = reconcileSpecific(range(10, 11), [row('a', 10, 11)])
    expect(result).toEqual({ deleteIds: ['a'], remainders: [] })
  })

  it('existing fully inside the new range -> deleted whole, no remainder', () => {
    const result = reconcileSpecific(range(10, 12), [row('a', 10, 11)])
    expect(result).toEqual({ deleteIds: ['a'], remainders: [] })
  })

  it('new range strictly inside an existing row -> two remainders, polarity preserved', () => {
    const result = reconcileSpecific(range(10, 11, false), [row('a', 9, 13, true)])
    expect(result.deleteIds).toEqual(['a'])
    expect(result.remainders).toEqual([
      { start_at: iso(at(9)), end_at: iso(at(10)), is_available: true },
      { start_at: iso(at(11)), end_at: iso(at(13)), is_available: true },
    ])
  })

  it('left partial overlap -> only the part before the new range survives', () => {
    const result = reconcileSpecific(range(10, 12), [
      { id: 'a', start_at: iso(at(9)), end_at: iso(at(10, 30)), is_available: true },
    ])
    expect(result.deleteIds).toEqual(['a'])
    expect(result.remainders).toEqual([
      { start_at: iso(at(9)), end_at: iso(at(10)), is_available: true },
    ])
  })

  it('right partial overlap -> only the part after the new range survives', () => {
    const result = reconcileSpecific(range(10, 12), [
      { id: 'a', start_at: iso(at(11, 30)), end_at: iso(at(13)), is_available: false },
    ])
    expect(result.deleteIds).toEqual(['a'])
    expect(result.remainders).toEqual([
      { start_at: iso(at(12)), end_at: iso(at(13)), is_available: false },
    ])
  })

  it('rows touching only at an endpoint do not overlap and are untouched', () => {
    // 09:00-10:00 ends exactly where the new range starts; 12:00-13:00 starts
    // exactly where it ends. Half-open [start, end) means neither overlaps.
    const result = reconcileSpecific(range(10, 12), [row('before', 9, 10), row('after', 12, 13)])
    expect(result).toEqual({ deleteIds: [], remainders: [] })
  })

  it('reconciles BOTH polarities in one call - the new action wins regardless', () => {
    // New range is "available"; it clears an overlapping unavailable row and an
    // overlapping available row alike, each keeping its own polarity in the
    // fragment written back.
    const result = reconcileSpecific(range(10, 12, true), [
      row('unavail', 9, 11, false),
      row('avail', 11, 13, true),
    ])
    expect(result.deleteIds).toEqual(['unavail', 'avail'])
    expect(result.remainders).toEqual([
      { start_at: iso(at(9)), end_at: iso(at(10)), is_available: false },
      { start_at: iso(at(12)), end_at: iso(at(13)), is_available: true },
    ])
  })

  it('trims several rows in one call and leaves non-overlapping ones alone', () => {
    const result = reconcileSpecific(range(10, 12), [
      row('left', 8, 11),      // partial on the left
      { id: 'inside', start_at: iso(at(10, 30)), end_at: iso(at(11)), is_available: true },
      row('right', 11, 14),    // partial on the right
      row('far', 15, 16),      // no overlap at all
    ])
    expect(result.deleteIds).toEqual(['left', 'inside', 'right'])
    expect(result.remainders).toEqual([
      { start_at: iso(at(8)), end_at: iso(at(10)), is_available: true },
      { start_at: iso(at(12)), end_at: iso(at(14)), is_available: true },
    ])
    expect(result.deleteIds).not.toContain('far')
  })

  it('degenerate new range (end <= start) reconciles nothing', () => {
    // Fail closed: a zero-or-negative window covers no minute, so it must not
    // delete a row it does not actually span.
    expect(reconcileSpecific(range(10, 10), [row('a', 9, 13)])).toEqual({
      deleteIds: [],
      remainders: [],
    })
    expect(reconcileSpecific(range(12, 10), [row('a', 9, 13)])).toEqual({
      deleteIds: [],
      remainders: [],
    })
  })

  it('unparseable or inverted existing rows are left alone', () => {
    const result = reconcileSpecific(range(10, 12), [
      { id: 'bad', start_at: 'not-a-date', end_at: iso(at(13)), is_available: true },
      { id: 'inverted', start_at: iso(at(13)), end_at: iso(at(11)), is_available: true },
      row('good', 10, 11),
    ])
    expect(result.deleteIds).toEqual(['good'])
    expect(result.remainders).toEqual([])
  })
})
