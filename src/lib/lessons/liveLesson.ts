import { createClient } from '@/lib/supabase/server'

// ---------------------------------------------------------------------------
// Live-lesson resolver (Milestone 4, Piece B).
//
// Single source of truth for "which class is live right now for this teacher".
// BOTH the autosave action AND the on-screen banner call this, so they can
// never disagree about which lesson a teacher's PDF marks belong to.
//
// W2 (wrong-class guard): the live lesson is derived HERE, server-side, from
// the schedule + the clock. The browser never names the class. A save can only
// ever attach marks to the lesson this resolver returns.
//
// Window rule is a DELIBERATELY SAFE SUBSET of the RLS write gate on
// lesson_annotations. That RLS gate allows a teacher write at ANY time UP TO
// scheduled_at + duration + 15min grace — keyed only on teacher_id, with NO
// lower time bound (a write is permitted during prep, or even for a lesson
// days away). This resolver is deliberately STRICTER on both ends:
//   - it requires the lesson to have STARTED (now >= scheduled_at), so prep-time
//     and future-lesson writes never get a live banner, and
//   - it requires status = 'scheduled', which silences autosave once a class is
//     completed/reported (teacher has moved on) and excludes cancelled lessons.
// The direction is safe: the resolver can only ever be STRICTER than RLS, never
// looser. So it can only name a lesson RLS would also accept — the banner can
// never name a class the write would then reject onto a different one. That is
// what W2 needs. (It does mean autosave goes quiet for the rest of the grace
// window if a teacher submits the report mid-class — that is intended: reported
// class = done.)
// ---------------------------------------------------------------------------

// 15-minute save-grace after a class ends. Matches the RLS cutoff verbatim.
export const GRACE_MINUTES = 15

export type LiveLesson = {
  lessonId: string
  studentName: string
  // The lesson's own scheduled start/end, for the banner's "your 9:00 class".
  scheduledAt: string
  endAt: string
}

// A lesson row as read for live-lesson resolution.
type LessonRow = {
  id: string
  scheduled_at: string
  duration_minutes: number
  student_id: string
}

// The core decision, pulled out as a PURE function so it is unit-testable
// without a database. Given the teacher's scheduled lessons and "now", return
// the one lesson that is live, applying the back-to-back tiebreaker.
//
// TIEBREAKER — read before editing:
// The no_teacher_overlap constraint forbids two lessons overlapping in real
// teaching time, but ALLOWS back-to-back lessons (a 09:00-10:00 and a
// 10:00-11:00). Just after 10:00 the first is still inside its 15-min grace
// AND the second is now being taught — so TWO lessons match "now is inside my
// window". The marks a teacher draws at 10:05 belong to the 10:00 class being
// TAUGHT, not the 09:00 class that only survives on grace.
// RULE: a lesson in real teaching time (start <= now < end) always wins over a
// lesson alive only on grace (end <= now < end+15). Grace is for finishing the
// just-ended class's marks, never for starting the next class's.
// Breaking this rule silently misattributes marks — the highest-stakes failure
// in this feature. The Vitest test locks it; do not weaken it.
export function pickLiveLesson(
  lessons: LessonRow[],
  nowMs: number
): LiveLesson | null {
  const graceMs = GRACE_MINUTES * 60_000

  let teaching: LiveLesson | null = null // start <= now < end
  let grace: LiveLesson | null = null    // end <= now < end + 15min

  for (const l of lessons) {
    const startMs = new Date(l.scheduled_at).getTime()
    const endMs = startMs + l.duration_minutes * 60_000

    const asLive: LiveLesson = {
      lessonId: l.id,
      studentName: '', // filled by the caller after a name lookup
      scheduledAt: l.scheduled_at,
      endAt: new Date(endMs).toISOString(),
    }

    if (nowMs >= startMs && nowMs < endMs) {
      // In real teaching time. This wins outright — return as soon as found.
      teaching = asLive
      break
    }
    if (nowMs >= endMs && nowMs < endMs + graceMs) {
      // Alive only on grace. Hold it, but keep looking for a teaching-time one.
      grace = grace ?? asLive
    }
  }

  return teaching ?? grace
}

// Resolve the live lesson for the CURRENTLY LOGGED-IN teacher.
// Read-only. Uses the user-scoped client so it sees only this teacher's rows.
// Returns null when no class is live (the normal "prep time" / "between
// classes" / "class ended" state — the banner shows the not-saving message).
export async function getLiveLessonForTeacher(): Promise<LiveLesson | null> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const nowMs = Date.now()
  // Upper bound only: a live lesson (teaching or grace) must have started no
  // later than now. The exact live decision — including the 15-min grace and the
  // back-to-back tiebreaker — is made in pickLiveLesson over the fetched rows,
  // NOT in SQL, so the risky logic lives in one unit-tested place.
  const earliestStart = new Date(nowMs).toISOString()

  const { data: lessons, error } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, student_id')
    .eq('teacher_id', user.id)
    .eq('status', 'scheduled')
    .lte('scheduled_at', earliestStart)
    // Lower bound is purely fetch-narrowing, NOT the live rule: exclude lessons
    // that ended long ago so the candidate list stays tiny. A lesson runs at
    // most a few hours, so bounding scheduled_at to the last 24h cannot drop a
    // genuinely live one (that would need a ~24h class). The grace cutoff is not
    // enforced in SQL at all; it is applied inside pickLiveLesson via the
    // endMs + graceMs comparison, over the fetched rows.
    .gte('scheduled_at', new Date(nowMs - 24 * 60 * 60_000).toISOString())
    .order('scheduled_at', { ascending: false })

  if (error || !lessons || lessons.length === 0) return null

  const picked = pickLiveLesson(lessons as LessonRow[], nowMs)
  if (!picked) return null

  // Look up the student's display name for the banner. Separate read so the
  // pure picker stays database-free and testable.
  const { data: student } = await supabase
    .from('students')
    .select('full_name')
    .eq('id', (lessons as LessonRow[]).find((l) => l.id === picked.lessonId)!.student_id)
    .maybeSingle()

  return {
    ...picked,
    studentName: student?.full_name ?? 'your student',
  }
}
