import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCallerProfile } from '@/lib/auth/callerProfile'
import { isStaffProfile } from '@/lib/auth/requireStaff'
import { getAssignedTeacherIds } from '@/lib/access/trainingAssignment'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
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
  // Detect admin/staff caller: they bypass the 24hr booking rule (enforced
  // independently on the write paths, e.g. student/book/route.ts), so the
  // 24hr-derived advisory cutoff below should not apply to them.
  //
  // The staff rule comes from isStaffProfile() (src/lib/auth/requireStaff.ts),
  // the single canonical definition shared with requireStaff() itself, rather
  // than a private copy of the expression here. Students have no profiles row,
  // so profile is null and isStaffProfile returns false.
  //
  // status === 'current' is part of that rule - the canonical active-account
  // gate - so a 'former'/'on_hold' profile keeps neither the 24hr cutoff bypass
  // nor the excludeLessonId privilege below.
  //
  // Deliberate change: a FAILED profiles read now throws out of
  // getCallerProfile() and surfaces as a 500, where it was previously swallowed
  // and treated as a non-staff caller. That is fail-closed and matches every
  // other gate in the app.
  const { user, profile } = await getCallerProfile()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }
  const isAdmin = isStaffProfile(profile)

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
  // reported unavailable against itself.
  //  - Admin/staff: honoured as-is (edit-class re-timing). Malformed ids are
  //    ignored silently.
  //  - Student: honoured ONLY after the ownership check further down (the
  //    student must own the lesson, it must be with THIS teacher, and it must
  //    still be scheduled). This mirrors api/student/book, which excludes
  //    rescheduleId from both clash queries and enforces a same-teacher lock,
  //    so read and write halves agree on what a reschedule may overlap.
  // The student booking WRITE paths enforce overlap independently of this
  // advisory endpoint (api/student/book: clash queries + DB exclusion
  // constraint; api/admin/classes: clash + constraint), so this cannot enable
  // a double-book. Without a param the student response is unchanged.
  const excludeLessonIdRaw = searchParams.get('excludeLessonId')
  const isUuid = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  const excludeLessonIdCandidate =
    excludeLessonIdRaw && isUuid(excludeLessonIdRaw) ? excludeLessonIdRaw : null
  let excludeLessonId: string | null = isAdmin ? excludeLessonIdCandidate : null

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

  // Assignment gate: a student may only read the availability of a teacher
  // assigned to one of their trainings. Previously any authenticated caller
  // could pass an arbitrary teacherId and read that teacher's whole working
  // week. Booking was never possible (api/student/book enforces the same
  // training_teachers rule on the write path) but the schedule itself is
  // staff information and must not be readable by unassigned students.
  //
  // Fail closed in both directions:
  //  - a non-admin caller with no students row has no assignments to check
  //    against, so it is denied rather than falling through;
  //  - getAssignedTeacherIds THROWS on query error (documented contract), so
  //    a verification failure is a 500, never a silent allow.
  if (!isAdmin) {
    if (!callerStudent) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    let assignedTeacherIds: Set<string>
    try {
      assignedTeacherIds = await getAssignedTeacherIds(admin, callerStudent.id)
    } catch (err) {
      console.error('[student availability] assignment check failed:', err)
      return NextResponse.json(
        { error: 'Could not load availability. Please try again.' },
        { status: 500 }
      )
    }
    if (!assignedTeacherIds.has(teacherId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Student excludeLessonId ownership check. Fail closed on query error.
    // A non-matching row (not theirs, other teacher, not scheduled) is
    // ignored silently, exactly like a malformed id.
    if (excludeLessonIdCandidate) {
      const { data: ownedLesson, error: ownedLessonError } = await admin
        .from('lessons')
        .select('id')
        .eq('id', excludeLessonIdCandidate)
        .eq('student_id', callerStudent.id)
        .eq('teacher_id', teacherId)
        .eq('status', 'scheduled')
        .maybeSingle()
      if (ownedLessonError) {
        console.error('[student availability] excludeLessonId ownership check failed:', ownedLessonError)
        return NextResponse.json(
          { error: 'Could not load availability. Please try again.' },
          { status: 500 }
        )
      }
      if (ownedLesson) excludeLessonId = ownedLesson.id
    }
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

  const { data: availabilityData, error: availabilityError } = await admin
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  // Fail closed, mirroring the three sibling reads in this handler: destructuring
  // data only left availabilityData null on a query error, so records became []
  // and the engine minted zero candidates. The student saw "no openings" under a
  // 200 and the client retry path never fired because the status was success.
  if (availabilityError) {
    console.error('[student availability] availability query failed:', availabilityError)
    return NextResponse.json(
      { error: 'Could not load availability. Please try again.' },
      { status: 500 }
    )
  }

  // Already booked lessons overlapping this week's instant window. BOTH bounds
  // are widened by the longest lesson duration: a lesson starting just before
  // the window still blocks the slots it overlaps inside it, and a lesson
  // starting at/after windowEndMs still blocks the NEW324 extended slots
  // (up to 60 min past the window end) it overlaps.
  // The status filter mirrors the lessons exclusion-constraint predicate
  // (no_teacher_overlap / no_student_overlap): it excludes exactly
  // CANCELLED_STATUSES, so a completed / no-show / missed lesson still occupies
  // its slot here and query and constraint cannot drift.
  let bookedQuery = admin
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', teacherId)
    .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
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

  // CAL8: the student's own non-cancelled lessons with OTHER teachers, same
  // widened instant window and the same exclusion-constraint status filter as
  // the teacher query above. Same-teacher lessons are already in the teacher
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
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
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
