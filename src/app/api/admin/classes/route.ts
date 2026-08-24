import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/auth/requireStaff'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createTeamsMeeting, cancelTeamsMeeting } from '@/lib/microsoft/graph'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  teacherNewBookingEmailContent,
  studentBookingConfirmationEmailContent,
} from '@/lib/email/templates'
import { localToUtc } from '@/lib/utils/timezone'
import { requireTz } from '@/lib/time/requireTz'
import { CANCELLED_STATUSES, NO_SHOW_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { createPendingReport } from '@/lib/reports/createPendingReport'
import { createLessonGoogleEvent } from '@/lib/google/lessonEvents'
import { adminClassesPostSchema } from '@/lib/validation/schemas'
import { localMidnightToUtc } from '@/lib/billing/monthRange'
import { raiseReconciliationTask } from '@/lib/admin/raiseReconciliationTask'
import { isRollbackProven, verifyLessonCommitted } from '@/lib/lessons/verifyLessonCommitted'

// GET /api/admin/classes
// Returns paginated, filtered list of all lessons with teacher and student info
export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // Confirm caller is admin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const staffUser = await requireStaff()
  if (!staffUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', user.id)
    .maybeSingle()

  // Parse query params for filters
  const { searchParams } = new URL(request.url)
  const teacherId = searchParams.get('teacher_id')
  const studentId = searchParams.get('student_id')
  const status = searchParams.get('status')        // upcoming|completed|cancelled|no_show|missed
  const dateFrom = searchParams.get('date_from')   // yyyy-mm-dd calendar day, admin-local
  const dateTo = searchParams.get('date_to')       // yyyy-mm-dd calendar day, admin-local (inclusive)
  const search = searchParams.get('search')        // free text — matches teacher or student name
  const page = parseInt(searchParams.get('page') ?? '1')
  const pageSize = 50

  // Pre-resolve the free-text search into teacher/student id lists BEFORE the
  // lessons query runs, so the filter composes with .range() and the exact count.
  // The previous approach filtered in JS after the page was sliced: pages came
  // back under-filled and `total` was the unfiltered count. full_name lives on
  // the joined profiles/students tables, not on lessons, so a direct .ilike on
  // the lessons query is impossible - mirror the batch-fetch-ids pattern in
  // api/admin/exports/[type]/route.ts instead.
  let searchTeacherIds: string[] = []
  let searchStudentIds: string[] = []
  let applySearch = false
  if (search) {
    // Sanitise for PostgREST: strip characters that would break .or()/.ilike()
    // filter syntax (commas, parentheses), then escape the ilike wildcards
    // (% and _) and the escape character itself so the term matches literally.
    const cleaned = search.replace(/[,()]/g, '').replace(/([\\%_])/g, '\\$1').trim()
    if (!cleaned) {
      // Term reduced to nothing (only stripped punctuation) - matches no name,
      // the same outcome the old post-fetch includes() filter produced.
      return NextResponse.json({ lessons: [], total: 0, page, pageSize })
    }
    const pattern = `%${cleaned}%`
    // .limit(500) is a defensive cap on each resolved id list - keeps the
    // .or() in-list bounded; far above any realistic roster size.
    const [teacherRes, studentRes] = await Promise.all([
      supabase.from('profiles').select('id').ilike('full_name', pattern).limit(500),
      supabase.from('students').select('id').ilike('full_name', pattern).limit(500),
    ])
    if (teacherRes.error || studentRes.error) {
      console.error('Classes search name lookup error:', teacherRes.error ?? studentRes.error)
      return NextResponse.json({ error: 'Search failed' }, { status: 500 })
    }
    searchTeacherIds = (teacherRes.data ?? []).map((p) => p.id)
    searchStudentIds = (studentRes.data ?? []).map((s) => s.id)
    // No name matched on either side: nothing can match the lessons query.
    if (searchTeacherIds.length === 0 && searchStudentIds.length === 0) {
      return NextResponse.json({ lessons: [], total: 0, page, pageSize })
    }
    applySearch = true
  }

  // Build query — join profiles (teacher) and students
  // allowed_durations rides along on the student embed as an EXPLICIT column
  // (never select('*') - students carries column-level REVOKEs). It feeds the
  // read-only duration marker in ClassesListClient and nothing else: admin
  // booking stays deliberately exempt from the per-student duration rule, so
  // this is display metadata on a row that already exists, never a gate. The
  // POST handler below does not read it.
  // The reports embed carries only id + status: the list's Report column links
  // straight at /admin/reports/<report id>, so it needs the id, and a lesson with
  // no report row must render a placeholder rather than a link that cannot resolve.
  // reports.lesson_id is UNIQUE (reports_lesson_id_key), so this is a to-one
  // relationship; the client still flattens it with the Array.isArray() check every
  // nested join in this project goes through. RLS on reports ("Admins can view all
  // reports") filters it to null for a staff caller who is not an admin, which the
  // same placeholder covers.
  let query = supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_at,
      cancellation_reason,
      cancelled_by,
      rescheduled_by,
      teams_join_url,
      training_id,
      teacher_id,
      student_id,
      profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url
      ),
      students!lessons_student_id_fkey (
        id,
        full_name,
        photo_url,
        allowed_durations
      ),
      reports (
        id,
        status
      )
    `, { count: 'exact' })

  if (teacherId) query = query.eq('teacher_id', teacherId)
  if (studentId) query = query.eq('student_id', studentId)

  // Free-text search: filter by the pre-resolved id lists (never the raw term).
  // Both sides matched -> OR across the two columns; one side empty -> plain
  // .in() on the other. Runs before .order()/.range(), so pagination and the
  // exact count reflect the filtered set, and it ANDs with the date/status
  // filters below like any other filter.
  if (applySearch) {
    if (searchTeacherIds.length > 0 && searchStudentIds.length > 0) {
      query = query.or(
        `teacher_id.in.(${searchTeacherIds.join(',')}),student_id.in.(${searchStudentIds.join(',')})`
      )
    } else if (searchTeacherIds.length > 0) {
      query = query.in('teacher_id', searchTeacherIds)
    } else {
      query = query.in('student_id', searchStudentIds)
    }
  }

  // The date filters name calendar DAYS in the admin's own timezone, but scheduled_at is
  // a UTC instant. Resolve each edge through localMidnightToUtc — the same helper
  // getDayRangeInTz uses for the dashboard's "Classes Today" bucket — into a half-open
  // [from-midnight, midnight-after-to) instant pair. The previous bare-string gte/lte
  // compared a yyyy-mm-dd against a timestamptz: that pinned both edges to UTC midnight,
  // so the To-day was excluded apart from its very first instant (from == to returned
  // almost nothing) and the day boundary was UTC rather than the admin's.
  // Fail-safe: with no timezone on the profile there is no local day to resolve, so the
  // original bare-string comparison stands unchanged rather than guessing UTC.
  const adminTz: string | null = profile?.timezone ?? null
  const isDateKey = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

  if (dateFrom && isDateKey(dateFrom)) {
    if (adminTz) {
      const [y, m, d] = dateFrom.split('-').map(Number)
      query = query.gte('scheduled_at', localMidnightToUtc(y, m, d, adminTz))
    } else {
      query = query.gte('scheduled_at', dateFrom)
    }
  }

  if (dateTo && isDateKey(dateTo)) {
    if (adminTz) {
      const [y, m, d] = dateTo.split('-').map(Number)
      // Next calendar day via the Date constructor's own month/year rollover — the same
      // approach getDayRangeInTz uses to find its exclusive end edge.
      const next = new Date(Date.UTC(y, m - 1, d + 1))
      query = query.lt(
        'scheduled_at',
        localMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), adminTz)
      )
    } else {
      query = query.lte('scheduled_at', dateTo)
    }
  }

  // Map friendly status filter to DB values
  if (status === 'upcoming') {
    query = query.in('status', ['scheduled']).gte('scheduled_at', new Date().toISOString())
  } else if (status === 'completed') {
    query = query.eq('status', 'completed')
  } else if (status === 'cancelled') {
    query = query.in('status', CANCELLED_STATUSES)
  } else if (status === 'no_show') {
    query = query.in('status', NO_SHOW_STATUSES)
  } else if (status === 'missed') {
    query = query.eq('status', 'missed')
  }

  // Cancelled lessons sort by most recently cancelled first; legacy rows with null cancelled_at fall back to scheduled_at
  if (status === 'cancelled') {
    query = query
      .order('cancelled_at', { ascending: false, nullsFirst: false })
      .order('scheduled_at', { ascending: false })
  } else {
    query = query.order('scheduled_at', { ascending: false })
  }
  query = query.range((page - 1) * pageSize, page * pageSize - 1)

  const { data: lessons, error, count } = await query

  if (error) {
    console.error('Classes list error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten nested Supabase join arrays
  const flattened = (lessons ?? []).map((lesson) => ({
    ...lesson,
    teacher: Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles,
    student: Array.isArray(lesson.students) ? lesson.students[0] : lesson.students,
    profiles: undefined,
    students: undefined,
  }))

  return NextResponse.json({ lessons: flattened, total: count ?? 0, page, pageSize })
}

// A refund owed for a book_class_atomic deduction that has already moved a
// student's hours, held for the window in which no lesson row exists yet. The
// admin POST has no reschedule path, so unlike the student route this is the
// refund shape only. See the pendingRefund declaration inside the handler.
type PendingRefund = { trainingId: string; studentId: string; hours: number }

// POST /api/admin/classes
// Admin creates a class manually, bypassing the 24hr and availability restrictions
export async function POST(request: NextRequest) {
  // Set the moment the lesson row is committed. Everything after that point is
  // documented non-blocking, so the catch below must report success once this is
  // non-null - a 500 there tells the admin a booking failed when it exists, and
  // BookingFlowClient leaves Confirm enabled with the selection intact, so a
  // retry on another slot books a second real class.
  let committedLessonId: string | null = null

  // Non-null means exactly this: book_class_atomic has moved this student's
  // hours, no refund has been dispatched, and no lesson row exists. Everything
  // it needs is captured here because training_id, student_id, hoursRequested
  // and adminClient are all const INSIDE the try and unreachable from the catch.
  //
  // Cleared at the DISPATCH of the existing refund rather than at its completion,
  // and again the moment committedLessonId is set. Dispatch, not completion,
  // because an RPC that throws mid-flight may already have been applied by the
  // database: re-running it from the catch could refund twice.
  let pendingRefund: PendingRefund | null = null

  // Non-null means a Teams meeting exists in Microsoft that no committed lesson
  // row points at. Same retirement discipline as pendingRefund. The commit
  // retirement is the important one - past that point the meeting IS the
  // student's live join link and must never be cancelled.
  let teamsMeetingId: string | null = null

  // The instant captured immediately before the lessons insert, used as the
  // created_at floor when a lost insert response has to be resolved by reading
  // the row back. Only the insert-failure handler reads it today; it is declared
  // out here with the three above rather than as a const beside the insert
  // because the outer catch needs the same value when it gains the same
  // verification, and a const inside the try would be invisible to it. Null
  // means the insert was never reached, so there is nothing to verify.
  let insertStartedAtIso: string | null = null

  try {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const staffUser = await requireStaff()
  if (!staffUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()

  const parsed = adminClassesPostSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request data.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { teacher_id, student_id, training_id, scheduled_at, duration_minutes } = parsed.data

  const durationCheck = z.union(
    [z.literal(30), z.literal(60), z.literal(90)],
    { error: 'Duration must be 30, 60, or 90 minutes' }
  ).safeParse(duration_minutes)
  if (!durationCheck.success) {
    return NextResponse.json({ error: durationCheck.error.issues[0].message }, { status: 400 })
  }

  // Fetch teacher timezone + eligibility fields
  const adminClient = createAdminClient()
  const { data: teacherProfile, error: tzError } = await adminClient
    .from('profiles')
    .select('timezone, status, account_types')
    .eq('id', teacher_id)
    .maybeSingle()
  if (tzError) {
    return NextResponse.json({ error: 'Failed to load teacher timezone' }, { status: 500 })
  }
  // Eligibility gate: the assignment target must be an active teacher. status='current'
  // is the canonical active-account gate (CLAUDE.md L135 / JOURNAL Bug 8). Runs before
  // scheduledAtUtc and before the lesson insert.
  const isEligibleTeacher =
    !!teacherProfile &&
    teacherProfile.status === 'current' &&
    Array.isArray(teacherProfile.account_types) &&
    teacherProfile.account_types.includes('teacher')
  if (!isEligibleTeacher) {
    return NextResponse.json({ error: 'Target teacher is not an active teacher', code: 'INVALID_TEACHER' }, { status: 400 })
  }
  if (!teacherProfile?.timezone) {
    return NextResponse.json({ error: 'Teacher not found or has no timezone set' }, { status: 404 })
  }
  const teacherTimezone = teacherProfile.timezone

  const scheduledAtUtc = localToUtc(scheduled_at, teacherTimezone)

  // Reject bookings set in the past
  if (new Date(scheduledAtUtc) < new Date()) {
    return NextResponse.json({ error: 'Cannot book a class in the past. Please select a future date and time.' }, { status: 400 })
  }

  // Verify the training exists, belongs to the submitted student, and has enough
  // hours remaining. The student_id filter mirrors student/book/route.ts — without
  // it a mismatched training_id deducts hours from another student's training.
  // Same 'Training not found' on wrong owner, so existence is not leaked.
  // .maybeSingle(): zero rows (wrong owner) is an expected case, not a throw.
  const { data: training, error: trainingError } = await supabase
    .from('trainings')
    .select('id, student_id, total_hours, hours_consumed, status')
    .eq('id', training_id)
    .eq('student_id', student_id)
    .maybeSingle()

  if (trainingError || !training) {
    return NextResponse.json({ error: 'Training not found' }, { status: 404 })
  }

  const hoursRequested = duration_minutes / 60
  const hoursRemaining = training.total_hours - training.hours_consumed

  if (hoursRemaining < hoursRequested) {
    return NextResponse.json(
      { error: `Insufficient hours. ${hoursRemaining.toFixed(1)}h remaining, ${hoursRequested}h required.` },
      { status: 400 }
    )
  }

  // Check teacher is not already booked at this time. The status filter mirrors
  // the lessons exclusion-constraint predicate (no_teacher_overlap /
  // no_student_overlap): it excludes exactly CANCELLED_STATUSES, so a completed
  // / no-show / missed lesson still counts as a clash here and query and
  // constraint cannot drift.
  const newStart = new Date(scheduledAtUtc)
  const newEnd = new Date(newStart.getTime() + duration_minutes * 60 * 1000)

  const { data: clashLessons, error: clashError } = await adminClient
    .from('lessons')
    .select('id, scheduled_at, duration_minutes')
    .eq('teacher_id', teacher_id)
    .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
    .lt('scheduled_at', newEnd.toISOString())
    .gte('scheduled_at', new Date(newStart.getTime() - 90 * 60 * 1000).toISOString())

  // Fail closed: a query error previously yielded an empty list, which reads as
  // "no clash" and lets the booking proceed straight past the overlap guard.
  if (clashError) {
    console.error('[admin create class] teacher clash check failed:', clashError)
    return NextResponse.json(
      { error: 'Could not verify availability. Please try again.' },
      { status: 500 }
    )
  }

  const hasClash = (clashLessons ?? []).some(
    (l) =>
      new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000 >
      newStart.getTime()
  )

  if (hasClash) {
    return NextResponse.json(
      { error: 'This time slot is no longer available. Please select a different time.' },
      { status: 409 }
    )
  }

  // Check the student is not already booked at this time. Mirrors the teacher
  // check above exactly (same adminClient, same select, same status filter, same
  // 90-minute back-window, same half-open JS overlap test) but keyed on
  // student_id. Backs the no_student_overlap DB exclusion constraint the same
  // way the teacher check backs no_teacher_overlap.
  const { data: studentClashLessons, error: studentClashError } = await adminClient
    .from('lessons')
    .select('id, scheduled_at, duration_minutes')
    .eq('student_id', student_id)
    .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
    .lt('scheduled_at', newEnd.toISOString())
    .gte('scheduled_at', new Date(newStart.getTime() - 90 * 60 * 1000).toISOString())

  // Fail closed, same reasoning as the teacher check above.
  if (studentClashError) {
    console.error('[admin create class] student clash check failed:', studentClashError)
    return NextResponse.json(
      { error: 'Could not verify availability. Please try again.' },
      { status: 500 }
    )
  }

  const hasStudentClash = (studentClashLessons ?? []).some(
    (l) =>
      new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000 >
      newStart.getTime()
  )

  if (hasStudentClash) {
    return NextResponse.json(
      { error: 'This student already has a class booked at this time.' },
      { status: 409 }
    )
  }

  // Atomic hours deduction via RPC — locks the training row, re-checks balance,
  // and increments hours_consumed in a single transaction. Closes the TOCTOU
  // window on the previous read-then-write pattern.
  // NEW257: book_class_atomic now RETURNS the id of the 'class_booking'
  // hours_log row it inserted. Capture it for the lesson_id backfill after the
  // lesson insert succeeds below.
  const { data: hoursLogId, error: deductError } = await adminClient.rpc('book_class_atomic', {
    p_training_id: training_id,
    p_hours_needed: hoursRequested,
  })

  if (deductError) {
    const msg = (deductError.message || '').toLowerCase()
    if (msg.includes('insufficient_hours')) {
      return NextResponse.json(
        { error: `Insufficient hours. ${hoursRemaining.toFixed(1)}h remaining, ${hoursRequested}h required.` },
        { status: 400 }
      )
    }
    if (msg.includes('training_not_active')) {
      return NextResponse.json({ error: 'This training is no longer active.' }, { status: 400 })
    }
    // Fall-through = neither insufficient_hours nor training_not_active, so this
    // is a transport/unknown failure and the RPC may have committed the deduction
    // before the response leg failed. Not auto-refunded: refund_hours_atomic has
    // no "was never deducted" guard, so a refund here could credit hours that
    // were never spent. Naming the row instead so hours_log can be checked by
    // hand. CRITICAL because this is the one deduction path with no compensation.
    console.error('CRITICAL: book_class_atomic failed - hours MAY have been deducted with no lesson, check hours_log for this training:', {
      training_id,
      student_id,
      hours: hoursRequested,
      error: deductError,
    })
    return NextResponse.json({ error: 'Failed to reserve hours. Please try again.' }, { status: 500 })
  }

  // Hours have been deducted. Own the refund from here until the insert-failure
  // handler dispatches it or the lesson is committed - the same three arguments
  // that handler's refund_hours_atomic call uses.
  pendingRefund = { trainingId: training_id, studentId: student_id, hours: hoursRequested }

  // Fetch teacher + student full names for the Teams meeting subject and,
  // later, the confirmation emails — hoisted here so both call sites share
  // this single pair of queries instead of fetching twice.
  const { data: teacherEmailProfile, error: teacherEmailProfileError } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', teacher_id)
    .single()

  if (teacherEmailProfileError) {
    console.error('[admin create class] teacher email profile lookup failed - class created, teacher email will be skipped:', { teacher_id, error: teacherEmailProfileError })
  }

  const { data: studentEmailData, error: studentEmailDataError } = await adminClient
    .from('students')
    .select('full_name, email, timezone')
    .eq('id', student_id)
    .single()

  if (studentEmailDataError) {
    console.error('[admin create class] student email data lookup failed - class created, student email will be skipped:', { student_id, error: studentEmailDataError })
  }

  // Create Teams meeting before inserting the lesson so the URL is available immediately
  let teamsJoinUrl: string | null = null
  try {
    console.log('[Teams] Creating meeting — AZURE_TENANT_ID set:', !!process.env.AZURE_TENANT_ID, '| AZURE_CLIENT_ID set:', !!process.env.AZURE_CLIENT_ID, '| AZURE_CLIENT_SECRET set:', !!process.env.AZURE_CLIENT_SECRET)
    const meeting = await createTeamsMeeting({
      subject: `LinguaLink class – ${studentEmailData?.full_name ?? 'Student'} with ${teacherEmailProfile?.full_name ?? 'Teacher'}`,
      startTime: scheduledAtUtc,
      durationMinutes: duration_minutes,
    })
    teamsJoinUrl = meeting.joinUrl
    teamsMeetingId = meeting.meetingId
    console.log('[Teams] Meeting created successfully:', teamsMeetingId)
  } catch (teamsErr) {
    console.error('[Teams] createTeamsMeeting failed — lesson will be created without a join URL:', teamsErr)
  }

  // Captured here and nowhere earlier: this is the created_at floor the
  // read-back uses to ignore rows that predate this request, and every
  // millisecond of slack widens the window in which somebody else's booking
  // could be mistaken for ours.
  insertStartedAtIso = new Date().toISOString()

  // Create the lesson record
  const { data: lesson, error: lessonError } = await adminClient
    .from('lessons')
    .insert({
      teacher_id,
      student_id,
      training_id,
      scheduled_at: scheduledAtUtc,
      duration_minutes,
      status: 'scheduled',
      teams_join_url: teamsJoinUrl,
      teams_meeting_id: teamsMeetingId,
    })
    .select('id')
    .single()

  if (lessonError) {
    const isSlotConflict = lessonError.code === '23P01'
    // A 23P01 carries the violated constraint name in the Postgres error text.
    // no_student_overlap means the STUDENT already has an overlapping class;
    // anything else (no_teacher_overlap) keeps the existing teacher-side wording.
    const isStudentSlotConflict =
      isSlotConflict &&
      `${lessonError.message} ${lessonError.details}`.includes('no_student_overlap')

    // Is the refund below actually owed? It is correct ONLY if the insert
    // rolled back. If the insert COMMITTED and merely lost its response,
    // refunding reverses hours the student has legitimately spent, cancels
    // the Teams meeting that is now the live class's join link, and answers
    // a 409 or a 500 that invites a rebook - a second real class.
    //
    // A SQLSTATE proves the rollback (see isRollbackProven), so the common
    // case - the 23P01 slot conflict the branches below are written for -
    // skips the read-back entirely and behaves exactly as it always has.
    // Only an UNPROVEN failure pays for a read.
    if (!isRollbackProven(lessonError)) {
      // scheduledAtUtc is the exact value the insert wrote to scheduled_at:
      // localToUtc already returns an ISO UTC instant, so unlike the student
      // route there is nothing to convert here.
      const verdict = await verifyLessonCommitted(adminClient, {
        teamsMeetingId,
        teacherId: teacher_id,
        studentId: student_id,
        trainingId: training_id,
        scheduledAtIso: scheduledAtUtc,
        durationMinutes: duration_minutes,
        requestStartIso: insertStartedAtIso,
      })

      if (verdict.outcome === 'committed') {
        // The class SUCCEEDED and only the reply died. Nothing is owed
        // back, so no refund; and the meeting must survive, because the
        // committed row carries its id and it is now this student's live
        // join link. Retiring both trackers is what stops the outer catch
        // refunding or cancelling behind us.
        committedLessonId = verdict.lessonId
        pendingRefund = null
        teamsMeetingId = null

        console.error('CRITICAL: lesson insert committed but its response was lost (admin-created class) - returning success without refunding:', {
          lesson_id: verdict.lessonId,
          training_id,
          student_id,
          error: lessonError,
        })

        // Everything the DATABASE owed this row is already done. Both
        // trg_create_pending_report and trg_snapshot_lesson_rate fire AFTER
        // INSERT on lessons, inside the row's own transaction, so a row that
        // committed carries its pending report and its rate snapshot even
        // when the response was lost. Nothing to recreate from here - only
        // the route-side follow-ups below the success path were missed, and
        // those are named on the reconciliation task.

        // hours is null, not hoursRequested: the class exists, so the hours are
        // correctly spent and there is no exposure to reconcile. The task is
        // raised for the follow-ups that were skipped, not for money.
        //
        // The three revalidatePath calls were skipped too and are
        // deliberately NOT listed: they are cache invalidations no human can
        // action, and every target re-renders per request anyway.
        await raiseReconciliationTask({
          studentId: student_id,
          trainingId: training_id,
          lessonId: verdict.lessonId,
          hours: null,
          context: 'lesson insert committed but response lost (admin-created class)',
          errorDetail: {
            note: 'Hours are correct and the class exists - no reversal owed. The pending report and teacher rate snapshot were written by AFTER INSERT triggers on lessons and need no action. Only the items below did not run.',
            skipped: [
              'the class_booking hours_log row was not linked to the new lesson, so hours_log.lesson_id is still null',
              'no Google Calendar event for the new class',
              'no booking confirmation email to the teacher or the student',
            ],
          },
        })

        // Same shape as the normal success return. A 409 or a 500 here would
        // invite a retry that books a second real class.
        return NextResponse.json({ lesson_id: verdict.lessonId }, { status: 201 })
      }

      if (verdict.outcome === 'unresolved') {
        // Neither state is proven, and the dangerous half of the pair is a
        // committed row: refunding or cancelling the meeting would each act on
        // a class that may be live. So nothing is written at all and a human
        // decides. Both trackers are retired for that reason - not because
        // either has been dispatched, but so the outer catch cannot refund or
        // cancel in our place. The meeting is deliberately left ALIVE in
        // Microsoft and named below.
        pendingRefund = null
        const unresolvedMeetingId = teamsMeetingId
        teamsMeetingId = null

        console.error('CRITICAL: lesson insert verdict unresolved (admin-created class) - no refund, no Teams cancel. Manual check required.', {
          training_id,
          student_id,
          scheduled_at: scheduledAtUtc,
          teams_meeting_id: unresolvedMeetingId,
          hours_requested: hoursRequested,
          reason: verdict.reason,
          detail: verdict.detail,
          error: lessonError,
        })

        // hours is the full deduction this request made, so it is the student's
        // exact exposure if the insert rolled back.
        await raiseReconciliationTask({
          studentId: student_id,
          trainingId: training_id,
          lessonId: null,
          hours: hoursRequested,
          context: 'lesson insert verdict unresolved - manual check required (admin-created class)',
          // Field order is load-bearing: raiseReconciliationTask JSON-renders
          // this and hard-truncates at 500 chars. A Graph event id is long,
          // and this is the one path that leaves a meeting alive in
          // Microsoft with no row pointing at it, so it goes FIRST and the
          // open-ended verdict detail goes last where truncation can only
          // eat what the CRITICAL log above already carries in full.
          errorDetail: {
            teamsMeetingId: unresolvedMeetingId,
            reason: verdict.reason,
            scheduledAt: scheduledAtUtc,
            detail: verdict.detail,
          },
        })

        return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
      }

      // 'not_committed': no row exists, the hours are genuinely owed back, and the refund below is correct. Fall through unchanged.
    }

    // Dispatching the refund here retires it: the catch must not run a second
    // one, including when the RPC throws mid-flight. The two CRITICAL branches
    // below stay the signal for a refund that comes back failed.
    pendingRefund = null

    console.error('Create lesson error — refunding deducted hours:', lessonError)
    // The RPC signals TRAINING_NOT_FOUND / LESSON_NOT_FOUND / ALREADY_REFUNDED in its jsonb payload, not as an error, so both channels must be checked.
    // A throw from the RPC never yields an { error } to destructure; it is
    // funnelled into refundError so the CRITICAL log and the admin task below
    // are reached on that path too.
    let refundData: { success?: boolean; code?: string } | null = null
    let refundError: unknown = null
    try {
      const refundResult = await adminClient.rpc('refund_hours_atomic', {
        p_training_id: training_id,
        p_hours: hoursRequested,
      })
      refundData = refundResult.data
      refundError = refundResult.error
    } catch (caughtErr) {
      refundError = caughtErr
    }
    if (refundError) {
      console.error('CRITICAL: refund_hours_atomic failed after lesson insert error:', {
        training_id,
        student_id,
        lesson_id: null,
        error: refundError,
      })
      // The log above is only visible in Vercel. Raise the same failure as an
      // admin task so it is visible to whoever reconciles hours. Cannot throw
      // and returns void - control flow below is unchanged.
      await raiseReconciliationTask({
        studentId: student_id,
        trainingId: training_id,
        lessonId: null,
        hours: hoursRequested,
        context: 'refund_hours_atomic failed after lesson insert error (admin-created class)',
        errorDetail: refundError,
      })
    } else if (refundData?.success === false) {
      console.error('CRITICAL: refund_hours_atomic reported failure after admin-create lesson insert error:', {
        training_id,
        student_id,
        lesson_id: null,
        code: refundData.code,
      })
      await raiseReconciliationTask({
        studentId: student_id,
        trainingId: training_id,
        lessonId: null,
        hours: hoursRequested,
        context: 'refund_hours_atomic reported failure after lesson insert error (admin-created class)',
        errorDetail: refundData.code,
      })
    }

    // Deliberately AFTER the refund dispatch above: cancelTeamsMeeting has no
    // timeout, and a hung Graph DELETE must never strand deducted hours.
    if (teamsMeetingId) {
      // Retired before dispatch so the catch cannot cancel it a second time.
      const orphanMeetingId = teamsMeetingId
      teamsMeetingId = null
      try {
        await cancelTeamsMeeting(orphanMeetingId)
      } catch (cancelError) {
        console.error('CRITICAL: orphan Teams meeting after admin-create insert failure:', {
          teams_meeting_id: orphanMeetingId,
          lesson_id: null,
          error: cancelError,
        })
      }
    }

    // Both branches above mean the hours were NOT returned, so a slot-conflict
    // 409 - which asserts the slot is gone and the hours are safe - would be a
    // false statement. Only report the conflict when the refund actually landed;
    // otherwise fall through to the generic 500 below.
    //
    // Unlike the student route, this buys no retry protection: BookingFlowClient
    // neither clears the selection nor refetches, and behaves identically on 409
    // and 500. What it does buy is the invariant that a 409 is never returned
    // alongside an open reconciliation task for the same request - the predicate
    // below is the same pair the two CRITICAL branches test. The cost is message
    // specificity on the failed-refund path (the ternary below is replaced by the
    // generic wording). Mirrors the student route's refundSucceeded gate.
    const refundSucceeded = !refundError && refundData?.success !== false

    if (isSlotConflict && refundSucceeded) {
      return NextResponse.json(
        {
          error: 'SLOT_NOT_AVAILABLE',
          message: isStudentSlotConflict
            ? 'This student already has a class booked at this time.'
            : 'This slot is no longer available - it was just booked by another student.',
        },
        { status: 409 }
      )
    }

    return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
  }

  // The lesson exists, so the hours are correctly spent and nothing is owed
  // back, and the meeting id is now carried by a real row - it is the student's
  // live join link, not an orphan. Everything below here is documented
  // non-blocking, which is what makes the catch's success return correct.
  committedLessonId = lesson.id
  pendingRefund = null
  teamsMeetingId = null

  // NEW257: backfill hours_log.lesson_id. book_class_atomic returned the id of
  // the 'class_booking' ledger row; now that the lesson exists, link the two.
  // Non-blocking: the booking already succeeded and the ledger row exists, so a
  // failure only leaves the link unset — log it and continue. Uses adminClient
  // (hours_log UPDATE runs under the service role / bypasses RLS).
  if (hoursLogId) {
    const { error: backfillError } = await adminClient
      .from('hours_log')
      .update({ lesson_id: lesson.id })
      .eq('id', hoursLogId)
    if (backfillError) {
      console.error('[NEW257] hours_log.lesson_id backfill failed (admin create):', {
        hours_log_id: hoursLogId,
        lesson_id: lesson.id,
        error: backfillError,
      })
    }
  }

  // NEW178: create the paired 'pending' report row the teacher later completes
  // via complete_report_atomic. Non-blocking: a failure must not stop the 201.
  const classEndsAtIso = new Date(new Date(scheduledAtUtc).getTime() + duration_minutes * 60 * 1000).toISOString()
  const { error: pendingReportError } = await createPendingReport(adminClient, lesson.id, teacher_id, classEndsAtIso)
  if (pendingReportError) {
    console.error('[NEW178] pending report create failed (admin create):', {
      lesson_id: lesson.id,
      error: pendingReportError,
    })
  }

  // GCAL REBUILD 2: mirror the class onto the connected Google Calendar as a
  // private time-block and store the event id on the lesson row. Non-blocking
  // by construction - createLessonGoogleEvent never throws and returns nothing,
  // so there is no branch here and no failure of it can change the 201 below.
  // Awaited rather than fired and forgotten because the serverless function can
  // be frozen the instant the response is returned, which would silently drop a
  // dangling promise mid-request.
  await createLessonGoogleEvent({
    lessonId: lesson.id,
    teacherId: teacher_id,
    studentName: studentEmailData?.full_name ?? 'Student',
    scheduledAtIso: scheduledAtUtc,
    durationMinutes: duration_minutes,
  })

  // One try per recipient. Both sends previously shared a try, so a null
  // teacher timezone threw at the teacher guard and the student never got
  // their confirmation for a class that had already been booked and paid for.
  if (teacherEmailProfile?.email) {
    try {
      const teacherBody = teacherNewBookingEmailContent(
        studentEmailData?.full_name ?? 'Your student',
        scheduledAtUtc,
        duration_minutes,
        requireTz(teacherEmailProfile.timezone, 'admin-book:teacher')
      )
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacherEmailProfile.email,
        subject: `Lingualink Online - New class booked with ${studentEmailData?.full_name ?? 'a student'}`,
        html: buildEmailTemplate({
          recipientName: teacherEmailProfile.full_name ?? 'Teacher',
          recipientFallback: 'Teacher',
          subject: 'New class booked',
          bodyHtml: teacherBody,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    } catch (emailErr) {
      console.error('[Email] Teacher booking confirmation email failed - lesson still created:', { lesson_id: lesson.id, error: emailErr })
    }
  }

  if (studentEmailData?.email) {
    try {
      const studentBody = studentBookingConfirmationEmailContent(
        scheduledAtUtc,
        duration_minutes,
        requireTz(studentEmailData.timezone, 'admin-book:student')
      )
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: studentEmailData.email,
        subject: 'Lingualink Online - Your class is confirmed',
        html: buildEmailTemplate({
          recipientName: studentEmailData.full_name ?? 'Student',
          recipientFallback: 'Student',
          subject: 'Your class is confirmed',
          bodyHtml: studentBody,
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    } catch (emailErr) {
      console.error('[Email] Student booking confirmation email failed - lesson still created:', { lesson_id: lesson.id, error: emailErr })
    }
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return NextResponse.json({ lesson_id: lesson.id }, { status: 201 })
  } catch (err) {
    if (committedLessonId) {
      // The lesson exists and the hours are correctly spent. Whatever threw was
      // one of the documented non-blocking follow-ups (ledger backfill, pending
      // report, Google mirror, emails, revalidate). Report success so the admin
      // is not invited to retry and book a second real class; the CRITICAL log
      // is the signal for manual follow-up.
      console.error('CRITICAL: post-commit step threw in POST /api/admin/classes - lesson committed, returning success:', {
        lesson_id: committedLessonId,
        error: err,
      })
      return NextResponse.json({ lesson_id: committedLessonId }, { status: 201 })
    }

    // No lesson row exists. If the deduction already moved this student's hours
    // and no refund has been dispatched, reverse it here. Its own try/catch and
    // a fresh service-role client: adminClient is scoped to the try above and
    // may never have been constructed. Whatever happens, the 500 below is still
    // returned and this catch never throws.
    if (pendingRefund) {
      const pending = pendingRefund
      pendingRefund = null
      try {
        const recoveryClient = createAdminClient()
        const { data: refundData, error: refundError } = await recoveryClient.rpc('refund_hours_atomic', {
          p_training_id: pending.trainingId,
          p_hours: pending.hours,
        })
        if (refundError) {
          console.error('CRITICAL: refund_hours_atomic failed after an unexpected throw in POST /api/admin/classes. Hours are deducted with no lesson - manual reconciliation required.', {
            training_id: pending.trainingId,
            student_id: pending.studentId,
            lesson_id: null,
            hours: pending.hours,
            error: refundError,
          })
          await raiseReconciliationTask({
            studentId: pending.studentId,
            trainingId: pending.trainingId,
            lessonId: null,
            hours: pending.hours,
            context: 'refund_hours_atomic failed after an unexpected throw (admin-created class)',
            errorDetail: refundError,
          })
        } else if (refundData?.success === false) {
          console.error('CRITICAL: refund_hours_atomic reported failure after an unexpected throw in POST /api/admin/classes. Hours are deducted with no lesson - manual reconciliation required.', {
            training_id: pending.trainingId,
            student_id: pending.studentId,
            lesson_id: null,
            hours: pending.hours,
            code: refundData.code,
          })
          await raiseReconciliationTask({
            studentId: pending.studentId,
            trainingId: pending.trainingId,
            lessonId: null,
            hours: pending.hours,
            context: 'refund_hours_atomic reported failure after an unexpected throw (admin-created class)',
            errorDetail: refundData.code,
          })
        } else {
          console.error('CRITICAL: hours auto-refunded after an unexpected throw in POST /api/admin/classes - no lesson was created.', {
            training_id: pending.trainingId,
            hours: pending.hours,
          })
        }
      } catch (compensationError) {
        console.error('CRITICAL: compensation threw after an unexpected throw in POST /api/admin/classes. Hours may be deducted with no lesson - manual reconciliation required.', {
          training_id: pending.trainingId,
          student_id: pending.studentId,
          lesson_id: null,
          hours: pending.hours,
          error: compensationError,
        })
        await raiseReconciliationTask({
          studentId: pending.studentId,
          trainingId: pending.trainingId,
          lessonId: null,
          hours: pending.hours,
          context: 'compensation threw after an unexpected throw (admin-created class)',
          errorDetail: compensationError,
        })
      }
    }

    // A Teams meeting was created and no lesson row was ever committed, so
    // nothing in the database points at it. Best-effort cancel. Placed after the
    // refund block so a slow or hanging Graph call can never delay the hours
    // reversal, and wrapped in its own try/catch because cancelTeamsMeeting
    // swallows a 404 as success but rethrows every other Graph failure - this
    // catch must not throw.
    if (teamsMeetingId) {
      const orphanMeetingId = teamsMeetingId
      teamsMeetingId = null
      try {
        await cancelTeamsMeeting(orphanMeetingId)
      } catch (cancelError) {
        console.error('CRITICAL: orphan Teams meeting after an unexpected throw in POST /api/admin/classes - no lesson row references it:', {
          teams_meeting_id: orphanMeetingId,
          lesson_id: null,
          error: cancelError,
        })
      }
    }

    console.error('POST /api/admin/classes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
