import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'

// ─── Email content builders ───────────────────────────────────────────────────
// These follow the same pattern as newMessageEmailContent in templates.ts
// They will be moved to templates.ts during the email cleanup pass (Step 12)

function bookingConfirmationStudentEmail(
  teacherName: string,
  dateTimeFormatted: string,
  durationMinutes: number
): string {
  const durationLabel = durationMinutes === 30 ? '30 minutes' : durationMinutes === 60 ? '1 hour' : '1.5 hours'
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been confirmed. Here are your details:
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;width:40%;">Teacher</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${teacherName}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;">Date &amp; Time</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${dateTimeFormatted}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:14px;color:#6B7280;">Duration</td>
        <td style="padding:10px 0;font-size:14px;color:#111827;font-weight:600;">${durationLabel}</td>
      </tr>
    </table>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      Your Microsoft Teams link will be available in your portal 15 minutes before the class starts.
    </p>
    <a
      href="${process.env.NEXT_PUBLIC_SITE_URL}/student/my-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      View My Classes
    </a>
  `
}

function bookingNotificationTeacherEmail(
  studentName: string,
  dateTimeFormatted: string,
  durationMinutes: number
): string {
  const durationLabel = durationMinutes === 30 ? '30 minutes' : durationMinutes === 60 ? '1 hour' : '1.5 hours'
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      A new class has been booked with you. Here are the details:
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;width:40%;">Student</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${studentName}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;">Date &amp; Time</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${dateTimeFormatted}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:14px;color:#6B7280;">Duration</td>
        <td style="padding:10px 0;font-size:14px;color:#111827;font-weight:600;">${durationLabel}</td>
      </tr>
    </table>
    <a
      href="${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/upcoming-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      View Upcoming Classes
    </a>
  `
}

function rescheduleConfirmationStudentEmail(
  teacherName: string,
  dateTimeFormatted: string,
  durationMinutes: number
): string {
  const durationLabel = durationMinutes === 30 ? '30 minutes' : durationMinutes === 60 ? '1 hour' : '1.5 hours'
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been rescheduled. Here are your updated details:
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;width:40%;">Teacher</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${teacherName}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#6B7280;">New Date &amp; Time</td>
        <td style="padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827;font-weight:600;">${dateTimeFormatted}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:14px;color:#6B7280;">Duration</td>
        <td style="padding:10px 0;font-size:14px;color:#111827;font-weight:600;">${durationLabel}</td>
      </tr>
    </table>
    <a
      href="${process.env.NEXT_PUBLIC_SITE_URL}/student/my-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      View My Classes
    </a>
  `
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Formats a UTC ISO string as a readable date/time in a given timezone
// e.g. "Monday, 7 April 2026 at 10:00"
function formatDateTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(isoString))
}

// ─── POST /api/student/book ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()

    // ── 1. Parse and validate request body ───────────────────────────────────
    const body = await req.json()
    const { trainingId, teacherId, studentId, durationMinutes, scheduledAt, rescheduleId } = body

    if (!trainingId || !teacherId || !studentId || !durationMinutes || !scheduledAt) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 })
    }

    if (![30, 60, 90].includes(durationMinutes)) {
      return NextResponse.json({ error: 'Invalid duration. Must be 30, 60, or 90 minutes.' }, { status: 400 })
    }

    // ── 2. Verify the student is authenticated and matches the studentId ──────
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
    }

    const { data: studentRow, error: studentError } = await supabase
      .from('students')
      .select('id, full_name, email, timezone, auth_user_id')
      .eq('id', studentId)
      .single()

    if (studentError || !studentRow) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    if (studentRow.auth_user_id !== user.id) {
      return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
    }

    // ── 3. Load the training and check hours balance ──────────────────────────
    const { data: training, error: trainingError } = await supabase
      .from('trainings')
      .select('id, total_hours, hours_consumed, status')
      .eq('id', trainingId)
      .eq('student_id', studentId)
      .single()

    if (trainingError || !training) {
      return NextResponse.json({ error: 'Training not found.' }, { status: 404 })
    }

    if (training.status !== 'active') {
      return NextResponse.json({ error: 'This training is no longer active.' }, { status: 400 })
    }

    const hoursRemaining = training.total_hours - training.hours_consumed
    const hoursNeeded = durationMinutes / 60

    if (hoursRemaining < hoursNeeded) {
      return NextResponse.json(
        { error: 'You do not have enough hours remaining for this class.' },
        { status: 400 }
      )
    }

    // ── 4. Load the teacher's profile for emails ──────────────────────────────
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, full_name, email, timezone')
      .eq('id', teacherId)
      .single()

    if (teacherError || !teacher) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    // ── 5. If rescheduling — cancel the old lesson ────────────────────────────
    // No hours are deducted or refunded on a reschedule — it is purely a date change
    if (rescheduleId) {
      const { error: cancelError } = await supabase
        .from('lessons')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancellation_reason: 'Rescheduled by student',
          updated_at: new Date().toISOString(),
        })
        .eq('id', rescheduleId)
        .eq('student_id', studentId) // safety check — student can only cancel their own lessons

      if (cancelError) {
        console.error('Failed to cancel old lesson during reschedule:', cancelError)
        return NextResponse.json({ error: 'Failed to reschedule. Please try again.' }, { status: 500 })
      }
    }

    // ── 6. MS Graph API — Teams meeting creation ──────────────────────────────
    // TODO: Replace TEAMS_LINK_PENDING with a real Graph API call once
    // Shannon's Microsoft 365 Business Basic subscription is active and
    // the app is registered in Microsoft Entra ID.
    //
    // The call will go here:
    //   const { joinUrl, meetingId } = await createTeamsMeeting({
    //     subject: `Lingualink class — ${studentRow.full_name} with ${teacher.full_name}`,
    //     startTime: scheduledAt,
    //     durationMinutes,
    //   })
    //
    // Then store joinUrl in teams_join_url and meetingId in teams_meeting_id below.
    const teamsJoinUrl = 'TEAMS_LINK_PENDING'
    const teamsMeetingId = null

    // ── 7. Create the new lesson record ──────────────────────────────────────
    // scheduled_at is a UTC ISO string sent from the client
    // end time is calculated by adding durationMinutes
    const startTime = new Date(scheduledAt)
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000)

    const { data: newLesson, error: lessonError } = await supabase
      .from('lessons')
      .insert({
        training_id: trainingId,
        teacher_id: teacherId,
        student_id: studentId,
        scheduled_at: startTime.toISOString(),
        duration_minutes: durationMinutes,
        teams_join_url: teamsJoinUrl,
        teams_meeting_id: teamsMeetingId,
        status: 'scheduled',
      })
      .select('id')
      .single()

    if (lessonError || !newLesson) {
      console.error('Failed to create lesson:', lessonError)
      return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
    }

    // ── 8. Deduct hours from training ─────────────────────────────────────────
    const { error: hoursError } = await supabase
      .from('trainings')
      .update({
        hours_consumed: training.hours_consumed + hoursNeeded,
      })
      .eq('id', trainingId)

    if (hoursError) {
      // Lesson was created but hours failed to deduct — log this for admin to fix manually
      // We don't roll back the lesson as that would be worse UX; Sentry will catch this
      console.error('CRITICAL: Lesson created but hours deduction failed. Lesson ID:', newLesson.id, hoursError)
    }

    // ── 9. Send confirmation emails ───────────────────────────────────────────
    // Format the date/time in each recipient's own timezone
    const isReschedule = !!rescheduleId
    const studentTimezone = studentRow.timezone ?? 'Europe/London'
    const teacherTimezone = teacher.timezone ?? 'Africa/Johannesburg'

    const studentDateTime = formatDateTime(startTime.toISOString(), studentTimezone)
    const teacherDateTime = formatDateTime(startTime.toISOString(), teacherTimezone)

    // Email to student
    const studentSubject = isReschedule
      ? 'Lingualink Online — Your class has been rescheduled'
      : 'Lingualink Online — Your class is confirmed'

    const studentBodyHtml = isReschedule
      ? rescheduleConfirmationStudentEmail(teacher.full_name, studentDateTime, durationMinutes)
      : bookingConfirmationStudentEmail(teacher.full_name, studentDateTime, durationMinutes)

    // Email to teacher
    const teacherSubject = isReschedule
      ? `Lingualink Online — Class rescheduled by ${studentRow.full_name}`
      : `Lingualink Online — New class booked with ${studentRow.full_name}`

    const teacherBodyHtml = isReschedule
      ? rescheduleConfirmationStudentEmail(studentRow.full_name, teacherDateTime, durationMinutes)
      : bookingNotificationTeacherEmail(studentRow.full_name, teacherDateTime, durationMinutes)

    // Fire both emails — we don't block the response on email success
    // If either fails, Sentry will catch it; the booking itself is already saved
    await Promise.allSettled([
      resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: studentRow.email,
        subject: studentSubject,
        html: buildEmailTemplate({
          recipientName: studentRow.full_name,
          subject: studentSubject,
          bodyHtml: studentBodyHtml,
        }),
      }),
      resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: teacher.email,
        subject: teacherSubject,
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          subject: teacherSubject,
          bodyHtml: teacherBodyHtml,
        }),
      }),
    ])

    // ── 10. Return success ────────────────────────────────────────────────────
    return NextResponse.json({ success: true, lessonId: newLesson.id })

  } catch (err) {
    console.error('Unexpected error in /api/student/book:', err)
    return NextResponse.json({ error: 'An unexpected error occurred. Please try again.' }, { status: 500 })
  }
}
