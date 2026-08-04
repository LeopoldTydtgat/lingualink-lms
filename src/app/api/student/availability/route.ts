import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  buildWeekSlots,
  getWeekWindow,
  MAX_LESSON_MS,
  type AvailabilityRecord,
  type BookedLesson,
} from './slotEngine'

// ─── Main handler ─────────────────────────────────────────────────────────────
//
// NEW317: all slot generation, blocking and bucketing lives in ./slotEngine
// (pure + unit-tested). This handler only does auth, param validation and the
// two DB reads, then hands the rows to the engine.

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Detect admin/staff caller: they bypass the 24hr booking rule (enforced
  // independently on the write paths, e.g. student/book/route.ts), so the
  // 24hr-derived advisory cutoff below should not apply to them. Students
  // have no profiles row -> maybeSingle returns null -> isAdmin false.
  // status === 'current' is required alongside the role/account_types check,
  // matching requireStaff (src/lib/auth/requireStaff.ts) - the canonical
  // active-account gate. A 'former'/'on_hold' profile therefore keeps neither
  // the 24hr cutoff bypass nor the excludeLessonId privilege below.
  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role, account_types, status')
    .eq('id', user.id)
    .maybeSingle()
  const isAdmin =
    callerProfile?.status === 'current' &&
    (callerProfile?.role === 'admin' ||
      callerProfile?.account_types?.includes('staff'))

  const { searchParams } = new URL(req.url)
  const teacherId = searchParams.get('teacherId')
  // YYYY-MM-DD — a calendar date in the DISPLAY timezone below (Monday for the
  // student booking grid; any weekday for the admin single-date flows).
  const weekStart = searchParams.get('weekStart')
  // The timezone the response keys are expressed in: the student's profile tz
  // for the student flow, the teacher's tz for the admin flows.
  const displayTimezone = searchParams.get('timezone')

  if (!teacherId || !weekStart) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }
  // localToUtc requires a well-formed date; fail closed instead of throwing.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'Invalid weekStart parameter' }, { status: 400 })
  }

  // Fail closed on the caller-supplied timezone: it is request input, not a DB
  // row, so a missing or invalid IANA value is a client bug we surface as a 400
  // rather than papering over with a guessed default.
  if (!displayTimezone) {
    return NextResponse.json({ error: 'Missing timezone parameter' }, { status: 400 })
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: displayTimezone })
  } catch {
    return NextResponse.json({ error: 'Invalid timezone parameter' }, { status: 400 })
  }

  // Optional: drop a single lesson from the booked set so its own slot is not
  // reported unavailable against itself (admin edit-class re-timing the lesson).
  // ADMIN/STAFF ONLY. The student booking WRITE paths enforce overlap
  // independently of this advisory endpoint (api/student/book: isSlotAvailable +
  // clash query + DB exclusion constraint; api/admin/classes: clash + constraint),
  // so this cannot enable a double-book — but gating it to admins keeps the student
  // availability response byte-identical and removes any occupied-slot-hiding
  // vector. Malformed ids are ignored silently.
  const excludeLessonIdRaw = searchParams.get('excludeLessonId')
  const isUuid = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  const excludeLessonId =
    isAdmin && excludeLessonIdRaw && isUuid(excludeLessonIdRaw) ? excludeLessonIdRaw : null

  // ── Fetch teacher's timezone ────────────────────────────────────────────────
  // Use the admin client so RLS on profiles/availability does not block the student's session.

  const admin = createAdminClient()

  // CAL8: resolve the caller's own student row so their existing bookings
  // with OTHER teachers can block the grid. Admin/staff callers have no
  // students row -> null -> merge below skips itself.
  const { data: callerStudent, error: callerStudentError } = await admin
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  // Fail closed, same reasoning as the booked-lessons query below: swallowing
  // this error would leave callerStudent null and silently re-open the
  // green-until-409 gap for every student whose row failed to load.
  if (callerStudentError) {
    console.error('[student availability] caller student lookup failed:', callerStudentError)
    return NextResponse.json(
      { error: 'Could not load availability. Please try again.' },
      { status: 500 }
    )
  }

  const { data: teacherProfile, error: tzError } = await admin
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .maybeSingle()

  if (tzError) {
    return NextResponse.json({ error: 'Failed to load teacher timezone' }, { status: 500 })
  }
  if (!teacherProfile?.timezone) {
    return NextResponse.json({ error: 'Teacher not found or has no timezone set' }, { status: 404 })
  }
  const teacherTimezone = teacherProfile.timezone

  // NEW317: the week is [weekStart 00:00, weekStart+7d 00:00) in the display
  // timezone, resolved to true UTC instants.
  const { windowStartMs, windowEndMs } = getWeekWindow(weekStart, displayTimezone)

  // ── Fetch availability records ──────────────────────────────────────────────

  const { data: availabilityData } = await admin
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  // Already booked lessons overlapping this week's instant window. BOTH bounds
  // are widened by the longest lesson duration: a lesson starting just before
  // the window still blocks the slots it overlaps inside it, and a lesson
  // starting at/after windowEndMs still blocks the NEW324 extended slots
  // (up to 60 min past the window end) it overlaps.
  let bookedQuery = admin
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', teacherId)
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date(windowStartMs - MAX_LESSON_MS).toISOString())
    .lt('scheduled_at', new Date(windowEndMs + MAX_LESSON_MS).toISOString())
  if (excludeLessonId) bookedQuery = bookedQuery.neq('id', excludeLessonId)
  const { data: bookedLessons, error: bookedError } = await bookedQuery

  // Fail closed: destructuring data only left `booked` as [] on a query error,
  // which the engine reads as "nothing booked" — every occupied slot would
  // render available and the grid would offer already-taken times.
  if (bookedError) {
    console.error('[student availability] booked lessons query failed:', bookedError)
    return NextResponse.json(
      { error: 'Could not load availability. Please try again.' },
      { status: 500 }
    )
  }

  // CAL8: the student's own scheduled lessons with OTHER teachers, same
  // widened instant window. Same-teacher lessons are already in the teacher
  // query above; .neq avoids double-listing them. Merged into `booked`
  // below — the engine blocks by instant overlap regardless of which side
  // of the clash the lesson sits on. Fail closed like the teacher query:
  // an error here would silently re-open the exact green-until-409 gap
  // this query exists to close.
  // Admin/staff callers are short-circuited even if a dual profiles+students
  // identity ever exists: the admin advisory grid must stay byte-identical
  // (same reasoning as the excludeLessonId gating above).
  let studentLessons: BookedLesson[] | null = null
  if (callerStudent && !isAdmin) {
    const { data: ownLessons, error: ownLessonsError } = await admin
      .from('lessons')
      .select('scheduled_at, duration_minutes')
      .eq('student_id', callerStudent.id)
      .eq('status', 'scheduled')
      .neq('teacher_id', teacherId)
      .gte('scheduled_at', new Date(windowStartMs - MAX_LESSON_MS).toISOString())
      .lt('scheduled_at', new Date(windowEndMs + MAX_LESSON_MS).toISOString())

    if (ownLessonsError) {
      console.error('[student availability] caller own lessons query failed:', ownLessonsError)
      return NextResponse.json(
        { error: 'Could not load availability. Please try again.' },
        { status: 500 }
      )
    }
    studentLessons = ownLessons
  }

  const records: AvailabilityRecord[] = availabilityData ?? []
  const booked: BookedLesson[] = [...(bookedLessons ?? []), ...(studentLessons ?? [])]

  const slotsByDate = buildWeekSlots({
    weekStart,
    displayTimezone,
    teacherTimezone,
    records,
    booked,
    nowMs: Date.now(),
    isAdmin: Boolean(isAdmin),
  })

  return NextResponse.json({ slots: slotsByDate })
}
