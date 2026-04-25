import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import { createTeamsMeeting } from '@/lib/microsoft/graph'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  teacherNewBookingEmailContent,
  studentBookingConfirmationEmailContent,
} from '@/lib/email/templates'

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
    .order('scheduled_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

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

  // Fetch teacher timezone
  const adminClient = createAdminClient()
  const { data: teacherProfile } = await adminClient
    .from('profiles')
    .select('timezone')
    .eq('id', teacher_id)
    .single()
  const teacherTimezone = teacherProfile?.timezone || 'UTC'

  // Convert naive local datetime to UTC using teacher's timezone
  // "2026-04-22T09:30:00" in teacherTimezone → UTC ISO string
  function localToUtc(localIso: string, tz: string): string {
    const [datePart, timePart] = localIso.split('T')
    const [year, month, day] = datePart.split('-').map(Number)
    const [hour, minute] = timePart.split(':').map(Number)
    const guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    })
    const parts = formatter.formatToParts(guessUtc)
    const localYear = parseInt(parts.find(p => p.type === 'year')!.value)
    const localMonth = parseInt(parts.find(p => p.type === 'month')!.value)
    const localDay = parseInt(parts.find(p => p.type === 'day')!.value)
    const localHour = parseInt(parts.find(p => p.type === 'hour')!.value)
    const localMinute = parseInt(parts.find(p => p.type === 'minute')!.value)
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0)
    const gotMs = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0)
    const diffMs = targetMs - gotMs
    return new Date(guessUtc.getTime() + diffMs).toISOString()
  }

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
    console.error('Create lesson error:', lessonError)
    return NextResponse.json({ error: lessonError.message }, { status: 500 })
  }

  // Deduct hours from training balance
  const { error: hoursError } = await supabase
    .from('trainings')
    .update({ hours_consumed: training.hours_consumed + hoursRequested })
    .eq('id', training_id)

  if (hoursError) {
    console.error('Hours deduction error:', hoursError)
    // Lesson was created — don't roll back, but log the issue
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
        teacherProfile.timezone ?? 'UTC'
      )
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: teacherProfile.email,
        subject: `Lingualink Online — New class booked with ${studentData?.full_name ?? 'a student'}`,
        html: buildEmailTemplate({
          recipientName: teacherProfile.full_name ?? 'Teacher',
          subject: 'New class booked',
          bodyHtml: teacherBody,
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    }

    if (studentData?.email) {
      const studentBody = studentBookingConfirmationEmailContent(
        teacherProfile?.full_name ?? 'Your teacher',
        scheduledAtUtc,
        duration_minutes,
        teamsJoinUrl,
        studentData.timezone ?? 'UTC'
      )
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: studentData.email,
        subject: 'Lingualink Online — Your class is confirmed',
        html: buildEmailTemplate({
          recipientName: studentData.full_name ?? 'Student',
          subject: 'Your class is confirmed',
          bodyHtml: studentBody,
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    }
  } catch (emailErr) {
    console.error('[Email] Booking confirmation emails failed — lesson still created:', emailErr)
  }

  return NextResponse.json({ lesson_id: lesson.id }, { status: 201 })
}
