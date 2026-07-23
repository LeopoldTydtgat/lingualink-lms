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
import { CANCELLED_STATUSES, NO_SHOW_STATUSES } from '@/lib/billing/billability'
import { createPendingReport } from '@/lib/reports/createPendingReport'
import { adminClassesPostSchema } from '@/lib/validation/schemas'
import { localMidnightToUtc } from '@/lib/billing/monthRange'

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
  const status = searchParams.get('status')        // upcoming|completed|cancelled|no_show
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
        photo_url
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
  } else if (status === 'flagged') {
    query = query.eq('status', 'flagged')
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

// POST /api/admin/classes
// Admin creates a class manually, bypassing the 24hr and availability restrictions
export async function POST(request: NextRequest) {
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

  // Check teacher is not already booked at this time
  const newStart = new Date(scheduledAtUtc)
  const newEnd = new Date(newStart.getTime() + duration_minutes * 60 * 1000)

  const { data: clashLessons } = await adminClient
    .from('lessons')
    .select('id, scheduled_at, duration_minutes')
    .eq('teacher_id', teacher_id)
    .eq('status', 'scheduled')
    .lt('scheduled_at', newEnd.toISOString())
    .gte('scheduled_at', new Date(newStart.getTime() - 90 * 60 * 1000).toISOString())

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
    console.error('book_class_atomic failed:', deductError)
    return NextResponse.json({ error: 'Failed to reserve hours. Please try again.' }, { status: 500 })
  }

  // Fetch teacher + student full names for the Teams meeting subject and,
  // later, the confirmation emails — hoisted here so both call sites share
  // this single pair of queries instead of fetching twice.
  const { data: teacherEmailProfile } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', teacher_id)
    .single()

  const { data: studentEmailData } = await adminClient
    .from('students')
    .select('full_name, email, timezone')
    .eq('id', student_id)
    .single()

  // Create Teams meeting before inserting the lesson so the URL is available immediately
  let teamsJoinUrl: string | null = null
  let teamsMeetingId: string | null = null
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

    if (teamsMeetingId) {
      try {
        await cancelTeamsMeeting(teamsMeetingId)
      } catch (cancelError) {
        console.error('CRITICAL: orphan Teams meeting after admin-create insert failure:', {
          teams_meeting_id: teamsMeetingId,
          lesson_id: null,
          error: cancelError,
        })
      }
    }

    console.error('Create lesson error — refunding deducted hours:', lessonError)
    const { error: refundError } = await adminClient.rpc('refund_hours_atomic', {
      p_training_id: training_id,
      p_hours: hoursRequested,
    })
    if (refundError) {
      console.error('CRITICAL: refund_hours_atomic failed after lesson insert error:', {
        training_id,
        student_id,
        lesson_id: null,
        error: refundError,
      })
    }

    if (isSlotConflict) {
      return NextResponse.json(
        { error: 'SLOT_NOT_AVAILABLE', message: 'This slot is no longer available - it was just booked by another student.' },
        { status: 409 }
      )
    }

    return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
  }

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

  // Send confirmation emails to teacher and student
  try {
    if (teacherEmailProfile?.email) {
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
    }

    if (studentEmailData?.email) {
      const studentBody = studentBookingConfirmationEmailContent(
        teacherEmailProfile?.full_name ?? 'Your teacher',
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
    }
  } catch (emailErr) {
    console.error('[Email] Booking confirmation emails failed — lesson still created:', emailErr)
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return NextResponse.json({ lesson_id: lesson.id }, { status: 201 })
  } catch (err) {
    console.error('POST /api/admin/classes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
