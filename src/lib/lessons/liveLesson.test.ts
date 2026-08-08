import { describe, it, expect } from 'vitest'
import { pickLiveLesson, pickAttributionLesson, GRACE_MINUTES } from './liveLesson'

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

describe('pickAttributionLesson — naming the class a teacher is sitting in', () => {
  // Attribution answers "which class was being taught at nowMs", for lessons the
  // caller has already filtered to the happened-in-their-slot statuses. It arms the
  // annotation guard when nothing is writable; it never selects a write target.
  const start = new Date('2026-07-01T10:00:00.000Z').getTime()
  const end = start + 60 * 60_000 // 11:00:00.000
  const l = { id: 'a', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 60 }

  it('returns null when there are no lessons', () => {
    expect(pickAttributionLesson([], NOW)).toBeNull()
  })

  it('names the lesson whose slot contains now', () => {
    expect(pickAttributionLesson([l], NOW)).toBe('a')
  })

  it('includes the exact start instant and excludes the exact end instant', () => {
    // Half-open [start, end), mirroring pickLiveLesson's teaching window so the two
    // can never disagree about which class an instant belongs to.
    expect(pickAttributionLesson([l], start)).toBe('a')
    expect(pickAttributionLesson([l], end - 1)).toBe('a')
    expect(pickAttributionLesson([l], end)).toBeNull()
  })

  it('grants NO grace — a just-ended lesson is not attributed', () => {
    // Grace exists so a finished class's marks can still be WRITTEN. Attribution is
    // not a write, and extending grace here would let a tab that merely sat through
    // the changeover claim the previous class.
    expect(pickAttributionLesson([l], end + 60_000)).toBeNull()
  })

  it('returns the same lesson pickLiveLesson calls live, across the handover', () => {
    // The invariant both functions' comments claim, asserted JOINTLY rather than as
    // two parallel literals: for any instant inside a teaching window the two must
    // name the same class, or a save could be refused as belonging to one lesson
    // while the write targets another. Probed across the A->B changeover.
    const rows = [
      { id: 'a', scheduled_at: '2026-07-01T09:00:00.000Z', duration_minutes: 60, student_id: 's1' },
      { id: 'b', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 60, student_id: 's2' },
    ]
    const base = new Date('2026-07-01T09:00:00.000Z').getTime()
    for (const offsetMin of [0, 30, 59, 60, 61, 90, 119]) {
      const t = base + offsetMin * 60_000
      expect(pickAttributionLesson(rows, t)).toBe(pickLiveLesson(rows, t)?.lessonId)
    }
  })

  it('does not depend on input order when only one lesson can match', () => {
    // no_teacher_overlap forbids two lessons overlapping in real teaching time, so at
    // most one row can contain a given instant. Pin that the result is order-free
    // rather than an artefact of the query's scheduled_at DESC sort.
    const early = { id: 'early', scheduled_at: '2026-07-01T08:00:00.000Z', duration_minutes: 60 }
    const later = { id: 'later', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 60 }
    expect(pickAttributionLesson([early, later], NOW)).toBe('later')
    expect(pickAttributionLesson([later, early], NOW)).toBe('later')
  })

  it('at a back-to-back handover, names the class now being taught', () => {
    // Same wrong-class instant pickLiveLesson guards: A 09:00-10:00, B 10:00-11:00,
    // probed at 10:00:00.000 exactly. A has ended; B owns the instant.
    const a2 = { id: 'a', scheduled_at: '2026-07-01T09:00:00.000Z', duration_minutes: 60 }
    const b2 = { id: 'b', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 60 }
    const handover = new Date('2026-07-01T10:00:00.000Z').getTime()
    expect(pickAttributionLesson([a2, b2], handover)).toBe('b')
    expect(pickAttributionLesson([b2, a2], handover)).toBe('b')
  })
})

describe('pickLiveLesson - grace suppression (the report-filed-mid-class instant)', () => {
  // The wrong-class instant the back-to-back tiebreaker above cannot see. `lessons`
  // carries status 'scheduled' rows only, so once B's report is filed mid-class B is
  // gone from the candidate list entirely and the PREVIOUS class A wins on grace -
  // marks drawn during B would land on A, under a Saved badge. Blockers are the
  // teacher's happened-status rows; a grace-only result dies while one owns the
  // instant. A: 09:00-10:00, so grace runs to 10:15 and NOW (10:05) sits inside it.
  const a = lesson('a', '2026-07-01T09:00:00.000Z', 60)
  const blockerB = { id: 'b', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 60 }

  it('suppresses a grace-only lesson while a blocker is being taught right now', () => {
    // Both halves matter: the first line is the bug (A returned), the second is the fix.
    expect(pickLiveLesson([a], NOW)?.lessonId).toBe('a')
    expect(pickLiveLesson([a], NOW, [blockerB])).toBeNull()
  })

  it('never suppresses a lesson in real teaching time', () => {
    // A is being TAUGHT at NOW and a blocker's window contains NOW too. Teaching is
    // the class the teacher is in, so it wins outright and grace suppression must not
    // reach it. (no_teacher_overlap makes this pair impossible in the database; the
    // test pins the RULE, not the data.)
    const teachingA = lesson('a', '2026-07-01T10:00:00.000Z', 60)
    expect(pickLiveLesson([teachingA], NOW, [blockerB])?.lessonId).toBe('a')
  })

  it('leaves a grace lesson alone when no blocker owns the instant', () => {
    // A blocker that ended well before now says nothing about where these marks
    // belong, so A's own grace window still carries them.
    const earlier = { id: 'z', scheduled_at: '2026-07-01T08:00:00.000Z', duration_minutes: 60 }
    expect(pickLiveLesson([a], NOW, [earlier])?.lessonId).toBe('a')
  })

  it('is unchanged with no blockers, whether [] or omitted (legacy behaviour)', () => {
    expect(pickLiveLesson([a], NOW, [])?.lessonId).toBe('a')
    expect(pickLiveLesson([a], NOW)?.lessonId).toBe('a')
  })

  it('returns null rather than falling through to another grace lesson', () => {
    // Suppression is not "pick the next-best grace": while a blocker is being taught
    // NOTHING is live, or the marks would simply land on a different wrong class.
    const alsoGrace = lesson('a2', '2026-07-01T09:55:00.000Z', 5) // ended 10:00
    expect(pickLiveLesson([a, alsoGrace], NOW, [blockerB])).toBeNull()
    expect(pickLiveLesson([alsoGrace, a], NOW, [blockerB])).toBeNull()
  })

  it('narrows only - any blockers give either the no-blocker answer or null', () => {
    // The invariant the resolver's safety argument rests on, and the one thing
    // getLiveLessonForTeacher relies on when it re-runs the pick with blockers: a
    // blocker can REMOVE the answer, never swap it for a different class. Probed
    // every 5 minutes across a back-to-back day against several blocker sets, rather
    // than asserted once, because "only narrows" is a claim about ALL inputs.
    const rows = [
      lesson('a', '2026-07-01T09:00:00.000Z', 60),
      lesson('b', '2026-07-01T10:00:00.000Z', 60),
    ]
    const later = { id: 'c', scheduled_at: '2026-07-01T11:00:00.000Z', duration_minutes: 60 }
    const blockerSets = [
      [],
      [blockerB],
      [{ id: 'a', scheduled_at: '2026-07-01T09:00:00.000Z', duration_minutes: 60 }],
      [later],
      [blockerB, later],
    ]
    const base = new Date('2026-07-01T09:00:00.000Z').getTime()
    let narrowed = 0
    for (let offsetMin = 0; offsetMin <= 140; offsetMin += 5) {
      const t = base + offsetMin * 60_000
      const baseline = pickLiveLesson(rows, t)
      for (const blockers of blockerSets) {
        const res = pickLiveLesson(rows, t, blockers)
        // null is always allowed; anything else must be the no-blocker answer, which
        // also fails loudly if blockers ever turned a null into a lesson.
        if (res !== null) expect(res).toEqual(baseline)
        if (baseline !== null && res === null) narrowed++
      }
    }
    // Anti-vacuity: the sweep must actually exercise suppression somewhere, or it
    // would still pass against an implementation that ignored blockers entirely.
    expect(narrowed).toBeGreaterThan(0)
  })

  describe('blocker window is half-open [start, end)', () => {
    // A (09:00-10:00) has grace to 10:15. Blocker B2 runs 10:00-10:10, wholly inside
    // that grace, so the blocker's edges can be probed while A stays live throughout.
    const bStart = new Date('2026-07-01T10:00:00.000Z').getTime()
    const bEnd = new Date('2026-07-01T10:10:00.000Z').getTime()
    const graceEnd = new Date('2026-07-01T09:00:00.000Z').getTime() + 60 * 60_000 + graceMs
    const b2 = { id: 'b2', scheduled_at: '2026-07-01T10:00:00.000Z', duration_minutes: 10 }

    it('suppresses at the exact blocker start instant (start is inside)', () => {
      expect(pickLiveLesson([a], bStart, [b2])).toBeNull()
    })

    it('suppresses one ms before the blocker end', () => {
      expect(pickLiveLesson([a], bEnd - 1, [b2])).toBeNull()
    })

    it('stops suppressing at the exact blocker end instant', () => {
      // The blocker no longer owns the instant, and A is still inside its own grace,
      // so A comes back and its last marks can still land.
      expect(bEnd).toBeLessThan(graceEnd)
      expect(pickLiveLesson([a], bEnd, [b2])?.lessonId).toBe('a')
    })
  })
})
