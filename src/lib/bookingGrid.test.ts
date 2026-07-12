import { describe, it, expect } from 'vitest'
import { isBookableStart } from './bookingGrid'

/**
 * NEW324 regression net for the booking-grid start check.
 *
 * The bug class: since NEW317 the availability API buckets each 30-min slot
 * under the student-local date of its own start instant, so a 60/90-min run
 * crossing student-local midnight has its continuation slots in the NEXT
 * day's column. The old within-column forward walk could never assemble such
 * a run, so its start was never offered. isBookableStart is pure instant
 * math against a week-wide set — these tests pin that it is tz/column
 * agnostic (instants only, built via Date.UTC).
 */

const HALF_HOUR = 30 * 60 * 1000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// Build a set of available start instants from a base ms + half-hour offsets.
function setOf(baseMs: number, ...halfHourOffsets: number[]): Set<number> {
  return new Set(halfHourOffsets.map((o) => baseMs + o * HALF_HOUR))
}

describe('isBookableStart', () => {
  it('60-min run fully within one day → true', () => {
    // 10:00 UTC start, 10:00 and 10:30 both available.
    const base = Date.UTC(2026, 6, 15, 10, 0)
    expect(isBookableStart(iso(base), 2, setOf(base, 0, 1))).toBe(true)
  })

  it('gap in the run → false', () => {
    // 10:00 available, 10:30 missing, 11:00 available: 90-min run has a hole.
    const base = Date.UTC(2026, 6, 15, 10, 0)
    expect(isBookableStart(iso(base), 3, setOf(base, 0, 2))).toBe(false)
  })

  it('middle slot unavailable (absent from the set) → false', () => {
    // Unavailable slots are never added to the set (BookingClient only adds
    // available === true), so a present-but-unavailable middle slot is an
    // absent instant — same failure as a gap, pinned separately.
    const base = Date.UTC(2026, 6, 15, 10, 0)
    const allInstants = setOf(base, 0, 1, 2)
    allInstants.delete(base + 1 * HALF_HOUR) // middle slot flips available=false
    expect(isBookableStart(iso(base), 3, allInstants)).toBe(false)
  })

  it('90-min run whose instants span student-local midnight → true', () => {
    // Student-local 23:00 start in a +13 frame (e.g. Auckland NZDT):
    // 2026-01-10 23:00 NZDT = 2026-01-10T10:00Z. The 23:30 and 00:00
    // continuations land on the NEXT student-local date (bucketed into the
    // next column by NEW317), but as instants they are just +30/+60 min.
    // The helper is tz-agnostic — only the instants matter.
    const base = Date.UTC(2026, 0, 10, 10, 0)
    expect(isBookableStart(iso(base), 3, setOf(base, 0, 1, 2))).toBe(true)
  })

  it('23:30 start with the 00:00 continuation absent → false', () => {
    // Tokyo student frame (+9): 2026-07-15 23:30 JST = 2026-07-15T14:30Z.
    // The 00:00 JST continuation (15:00Z) is missing → 60-min start fails.
    const base = Date.UTC(2026, 6, 15, 14, 30)
    expect(isBookableStart(iso(base), 2, setOf(base, 0))).toBe(false)
  })

  it('slotsNeeded = 1 with the start present → true', () => {
    const base = Date.UTC(2026, 6, 15, 10, 0)
    expect(isBookableStart(iso(base), 1, setOf(base, 0))).toBe(true)
  })

  it('slotsNeeded = 1 with the start absent → false', () => {
    const base = Date.UTC(2026, 6, 15, 10, 0)
    expect(isBookableStart(iso(base), 1, new Set<number>())).toBe(false)
  })
})
