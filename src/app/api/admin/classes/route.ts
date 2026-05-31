import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
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

// GET /api/admin/classes
// Returns paginated, filtered list of all lessons with teacher and student info
export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // Confirm caller is admin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Parse query params for filters
  const { searchParams } = new URL(request.url)
  const teacherId = searchParams.get('teacher_id')
  const studentId = searchParams.get('student_id')
  const status = searchParams.get('status')        // upcoming|completed|cancelled|no_show
  const dateFrom = searchParams.get('date_from')   // ISO date string
  const dateTo = searchParams.get('date_to')       // ISO date string
  const search = searchParams.get('search')        // free text — matches teacher or student name
  const page = parseInt(searchParams.get('page') ?? '1')
  const pageSize = 50

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
  if (dateFrom) query = query.gte('scheduled_at', dateFrom)
  if (dateTo) query = query.lte('scheduled_at', dateTo)

  // Map friendly status filter to DB values
  if (status === 'upcoming') {
    query = query.in('status', ['scheduled']).gte('scheduled_at', new Date().toISOString())
  } else if (status === 'completed') {
    query = query.eq('status', 'completed')
  } else if (status === 'cancelled') {
    query = query.in('status', ['cancelled', 'cancelled_by_student', 'cancelled_by_teacher'])
  } else if (status === 'no_show') {
    query = query.in('status', ['student_no_show', 'teacher_no_show'])
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

  // Client-side search filter on teacher/student name (Supabase doesn't support
  // cross-table ilike easily without a view, so we filter after fetch for now)
  const results = search
    ? flattened.filter((l) => {
        const q = search.toLowerCase()
        return (
          l.teacher?.full_name?.toLowerCase().includes(q) ||
          l.student?.full_name?.toLowerCase().includes(q)
        )
      })
    : flattened

  return NextResponse.json({ lessons: results, total: count ?? 0, page, pageSize })
}

// POST /api/admin/classes
// Admin creates a class manually, bypassing the 24hr and availability restrictions
export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const { teacher_id, student_id, training_id, scheduled_at, duration_minutes } = body

  if (!teacher_id || !student_id || !training_id || !scheduled_at || !duration_minutes) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

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
  // is the canonical active-account gate; is_active is deprecated (CLAUDE.md L135 /
  // JOURNAL Bug 8). Runs before scheduledAtUtc and before the lesson insert.
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

  // Verify the training exists and has enough hours remaining
  const { data: training, error: trainingError } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, status')
    .eq('id', training_id)
    .single()

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
  const { error: deductError } = await adminClient.rpc('book_class_atomic', {
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

  // Create Teams meeting before inserting the lesson so the URL is available immediately
  let teamsJoinUrl: string | null = null
  let teamsMeetingId: string | null = null
  try {
    console.log('[Teams] Creating meeting — AZURE_TENANT_ID set:', !!process.env.AZURE_TENANT_ID, '| AZURE_CLIENT_ID set:', !!process.env.AZURE_CLIENT_ID, '| AZURE_CLIENT_SECRET set:', !!process.env.AZURE_CLIENT_SECRET)
    const meeting = await createTeamsMeeting({
      subject: `LinguaLink lesson — ${scheduledAtUtc}`,
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
  const { data: lesson, error: lessonError } = await supabase
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

  // Send confirmation emails to teacher and student
  try {
    // Fetch teacher profile for email and timezone
    const { data: teacherProfile } = await adminClient
      .from('profiles')
      .select('full_name, email, timezone')
      .eq('id', teacher_id)
      .single()

    // Fetch student for email and timezone
    const { data: studentData } = await adminClient
      .from('students')
      .select('full_name, email, timezone')
      .eq('id', student_id)
      .single()

    if (teacherProfile?.email) {
      const teacherBody = teacherNewBookingEmailContent(
        studentData?.full_name ?? 'Your student',
        scheduledAtUtc,
        duration_minutes,
        requireTz(teacherProfile.timezone, 'admin-book:teacher')
      )
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: teacherProfile.email,
        subject: `Lingualink Online — New class booked with ${studentData?.full_name ?? 'a student'}`,
        html: buildEmailTemplate({
          recipientName: teacherProfile.full_name ?? 'Teacher',
          recipientFallback: 'Teacher',
          subject: 'New class booked',
          bodyHtml: teacherBody,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    }

    if (studentData?.email) {
      const studentBody = studentBookingConfirmationEmailContent(
        teacherProfile?.full_name ?? 'Your teacher',
        scheduledAtUtc,
        duration_minutes,
        requireTz(studentData.timezone, 'admin-book:student')
      )
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: studentData.email,
        subject: 'Lingualink Online — Your class is confirmed',
        html: buildEmailTemplate({
          recipientName: studentData.full_name ?? 'Student',
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
}
