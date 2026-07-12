import { describe, it, expect } from 'vitest'
import { pickLiveLesson, GRACE_MINUTES } from './liveLesson'

// Fixed clock for the general cases.
const NOW = new Date('2026-07-01T10:05:00.000Z').getTime()
const graceMs = GRACE_MINUTES * 60_000

function lesson(id: string, startIso: string, durationMinutes: number, studentId = 's1') {
  return { id, scheduled_at: startIso, duration_minutes: durationMinutes, student_id: studentId }
}

describe('pickLiveLesson — general cases', () => {
  it('returns null when there are no lessons', () => {
    expect(pickLiveLesson([], NOW)).toBeNull()
  })

  it('returns null when the only lesson has not started yet (prep time)', () => {
    const l = lesson('a', '2026-07-01T10:30:00.000Z', 60)
    expect(pickLiveLesson([l], NOW)).toBeNull()
  })

  it('returns the lesson currently in real teaching time', () => {
    const l = lesson('a', '2026-07-01T10:00:00.000Z', 60)
    expect(pickLiveLesson([l], NOW)?.lessonId).toBe('a')
  })

  it('keeps a just-ended lesson live during the 15-minute grace', () => {
    const l = lesson('a', '2026-07-01T09:50:00.000Z', 10)
    expect(pickLiveLesson([l], NOW)?.lessonId).toBe('a')
  })

  it('drops a lesson once it is past end + 15-minute grace', () => {
    const endMs = new Date('2026-07-01T09:49:00.000Z').getTime()
    const startIso = new Date(endMs - 10 * 60_000).toISOString()
    const l = lesson('a', startIso, 10)
    expect(endMs + graceMs).toBeLessThan(NOW)
    expect(pickLiveLesson([l], NOW)).toBeNull()
  })
})

describe('pickLiveLesson — exact boundaries (regression guards for < vs <=)', () => {
  // A single 10:00–11:00 lesson, probed at its exact edge instants.
  const start = new Date('2026-07-01T10:00:00.000Z').getTime()
  const end = start + 60 * 60_000            // 11:00:00.000
  const graceEnd = end + graceMs             // 11:15:00.000
  const l = lesson('a', '2026-07-01T10:00:00.000Z', 60)

  it('is LIVE at the exact start instant (now === start)', () => {
    // teaching window is [start, end): start itself must count.
    expect(pickLiveLesson([l], start)?.lessonId).toBe('a')
  })

  it('is LIVE one ms before end', () => {
    expect(pickLiveLesson([l], end - 1)?.lessonId).toBe('a')
  })

  it('is LIVE (on grace) at the exact end instant (now === end)', () => {
    // teaching is half-open [start,end) so end flips to grace, which is [end, graceEnd).
    // Either way the lesson is still live at end — this pins the teaching→grace handover.
    expect(pickLiveLesson([l], end)?.lessonId).toBe('a')
  })

  it('is LIVE one ms before grace expiry', () => {
    expect(pickLiveLesson([l], graceEnd - 1)?.lessonId).toBe('a')
  })

  it('is DEAD at the exact grace-expiry instant (now === end + 15min)', () => {
    // grace is half-open [end, graceEnd): graceEnd itself is no longer live.
    expect(pickLiveLesson([l], graceEnd)).toBeNull()
  })
})

describe('pickLiveLesson — back-to-back tiebreaker (the wrong-class instant)', () => {
  // A: 09:00–10:00, B: 10:00–11:00.
  const a = lesson('a', '2026-07-01T09:00:00.000Z', 60, 's1')
  const b = lesson('b', '2026-07-01T10:00:00.000Z', 60, 's2')

  it('at 10:05, teaching-time B wins over grace A — regardless of input order', () => {
    const now = new Date('2026-07-01T10:05:00.000Z').getTime()
    expect(pickLiveLesson([a, b], now)?.lessonId).toBe('b')
    expect(pickLiveLesson([b, a], now)?.lessonId).toBe('b')
  })

  it('at the EXACT handover instant 10:00:00.000, marks belong to B (the class now starting), not A', () => {
    // THE most dangerous instant in this feature: A just ended, B just started.
    // A is now on grace, B is now teaching. Teaching must win, both orderings.
    const handover = new Date('2026-07-01T10:00:00.000Z').getTime()
    expect(pickLiveLesson([a, b], handover)?.lessonId).toBe('b')
    expect(pickLiveLesson([b, a], handover)?.lessonId).toBe('b')
  })
})

describe('pickLiveLesson — two lessons both on grace', () => {
  // Neither is being taught now; both are inside their 15-min grace.
  // A ended at 10:00, B ended at 10:02, now 10:10 — both still on grace.
  // No teaching-time lesson exists, so a grace lesson is returned. This test
  // documents that SOME grace lesson wins (the resolver never returns null when
  // a valid grace lesson exists); it does not assert WHICH, because that would
  // couple the pure function to the query's sort order. The live query orders
  // scheduled_at DESC, but the pure function must not silently depend on that.
  const a = lesson('a', '2026-07-01T09:55:00.000Z', 5)  // ended 10:00
  const b = lesson('b', '2026-07-01T09:57:00.000Z', 5)  // ended 10:02
  const now = new Date('2026-07-01T10:10:00.000Z').getTime()

  it('returns a (some) live grace lesson, never null, when only grace lessons exist', () => {
    const res = pickLiveLesson([a, b], now)
    expect(res).not.toBeNull()
    expect(['a', 'b']).toContain(res!.lessonId)
  })
})
