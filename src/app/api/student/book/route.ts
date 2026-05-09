import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'
import { createTeamsMeeting, cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { BookClassSchema } from '@/lib/validation/schemas'
import { revalidatePath } from 'next/cache'
import { isSlotAvailable } from '@/lib/availability'
import { checkStudentBookingLimit } from '@/lib/rateLimit'

// ── Email content builders ────────────────────────────────────────────────────

function bookingConfirmationStudentEmail(
  teacherName: string,
  dateTimeFormatted: string,
  durationMinutes: number,
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
    <p style="margin:0;font-size:13px;color:#6B7280;line-height:1.6;">
      The Join Class button in your portal activates 10 minutes before the class starts.
    </p>
  `
}

function bookingNotificationTeacherEmail(
  studentName: string,
  dateTimeFormatted: string,
  durationMinutes: number,
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
  `
}

function rescheduleConfirmationStudentEmail(
  teacherName: string,
  dateTimeFormatted: string,
  durationMinutes: number,
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
  `
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── POST /api/student/book ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()

    // ── 1. Parse and validate request body ───────────────────────────────────
    const body = await req.json()

    const parsed = BookClassSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const { trainingId, teacherId, studentId, durationMinutes, scheduledAt, rescheduleId } = parsed.data

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

    // ── 2b. Rate limit per student (10 bookings / 60 min, fail closed) ───────
    const rl = await checkStudentBookingLimit(studentRow.id)
    if (rl.blocked) {
      return NextResponse.json(
        { error: 'Too many booking attempts. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
      )
    }

    // ── 3. Load the training and check hours balance ───────────────────────────
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

    // ── 3b. Enforce 24-hour booking rule ─────────────────────────────────────────
    const hoursUntilClass = (new Date(scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursUntilClass < 24) {
      return NextResponse.json(
        { error: 'Classes cannot be booked within 24 hours of the start time.' },
        { status: 400 }
      )
    }

    const adminClient = createAdminClient()

    // ── 3c. Re-check teacher availability server-side ─────────────────────────
    const slotAvailable = await isSlotAvailable(teacherId, scheduledAt, durationMinutes, adminClient)
    if (!slotAvailable) {
      return NextResponse.json(
        { error: 'This time slot is no longer available. Please pick another.', code: 'SLOT_NOT_AVAILABLE' },
        { status: 409 }
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

    // ── 4b. Check teacher is not already booked at this time ─────────────────
    const newStart = new Date(scheduledAt)
    const newEnd = new Date(newStart.getTime() + durationMinutes * 60 * 1000)

    const { data: clashLessons } = await adminClient
      .from('lessons')
      .select('id, scheduled_at, duration_minutes')
      .eq('teacher_id', teacherId)
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

    // ── 4c. Atomic hours reservation ──────────────────────────────────────────
    // Reschedule path uses reschedule_class_atomic, which cancels the old
    // lesson, refunds its hours, and deducts the new hours in a single
    // transaction. Fresh-booking path uses book_class_atomic, which only
    // deducts. Both take row-level locks and re-validate state inside the
    // transaction, closing the read-then-write TOCTOU window.
    let oldDurationHours = 0
    let oldTeamsMeetingId: string | null = null

    if (rescheduleId) {
      const { data: oldLesson, error: oldLessonError } = await adminClient
        .from('lessons')
        .select('duration_minutes, teams_meeting_id')
        .eq('id', rescheduleId)
        .eq('student_id', studentId)
        .eq('status', 'scheduled')
        .maybeSingle()

      if (oldLessonError || !oldLesson) {
        return NextResponse.json(
          { error: 'Original lesson not found or no longer reschedulable.' },
          { status: 404 }
        )
      }

      oldDurationHours = oldLesson.duration_minutes / 60
      oldTeamsMeetingId = oldLesson.teams_meeting_id ?? null

      const { error: rescheduleError } = await adminClient.rpc('reschedule_class_atomic', {
        p_old_lesson_id: rescheduleId,
        p_student_id: studentId,
        p_training_id: trainingId,
        p_old_duration_hours: oldDurationHours,
        p_new_duration_hours: hoursNeeded,
      })

      if (rescheduleError) {
        const msg = (rescheduleError.message || '').toLowerCase()
        if (msg.includes('insufficient_hours')) {
          return NextResponse.json(
            { error: 'You do not have enough hours remaining for this class.' },
            { status: 400 }
          )
        }
        if (msg.includes('old_lesson_not_reschedulable')) {
          return NextResponse.json(
            { error: 'Original lesson not found or no longer reschedulable.' },
            { status: 404 }
          )
        }
        if (msg.includes('training_not_found')) {
          return NextResponse.json({ error: 'Training not found.' }, { status: 404 })
        }
        console.error('reschedule_class_atomic failed:', rescheduleError)
        return NextResponse.json(
          { error: 'Failed to reschedule. Please try again.' },
          { status: 500 }
        )
      }
    } else {
      const { error: deductError } = await adminClient.rpc('book_class_atomic', {
        p_training_id: trainingId,
        p_hours_needed: hoursNeeded,
      })

      if (deductError) {
        const msg = (deductError.message || '').toLowerCase()
        if (msg.includes('insufficient_hours')) {
          return NextResponse.json(
            { error: 'You do not have enough hours remaining for this class.' },
            { status: 400 }
          )
        }
        if (msg.includes('training_not_active')) {
          return NextResponse.json(
            { error: 'This training is no longer active.' },
            { status: 400 }
          )
        }
        console.error('book_class_atomic failed:', deductError)
        return NextResponse.json(
          { error: 'Failed to reserve hours. Please try again.' },
          { status: 500 }
        )
      }
    }

    // ── 5. MS Graph API – create Teams meeting ────────────────────────────────
    // Meeting is created under the shared organiser account.
    // The join URL is tied to the lesson slot – not the teacher –
    // so teacher swaps never break the student's link.
    let teamsJoinUrl: string | null = null
    let teamsMeetingId: string | null = null

    try {
      const meeting = await createTeamsMeeting({
        subject: `Lingualink class – ${studentRow.full_name} with ${teacher.full_name}`,
        startTime: scheduledAt,
        durationMinutes,
      })
      teamsJoinUrl = meeting.joinUrl
      teamsMeetingId = meeting.meetingId
    } catch (graphError) {
      // Log the error but don't block the booking –
      // admin can manually fix the link if Graph API fails.
      // Sentry will capture this.
      console.error('MS Graph API failed – booking will proceed without Teams link:', graphError)
    }

    // ── 6. Create the new lesson record ───────────────────────────────────────
    const startTime = new Date(scheduledAt)

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
      if (rescheduleId) {
        // Reschedule recovery: reschedule_class_atomic has already cancelled
        // the old lesson and applied net delta (new - old) to hours_consumed.
        // unwind_reschedule_atomic restores the old lesson to scheduled and
        // reverses the hours delta in a single transaction. Any orphaned
        // Teams meeting created earlier is cancelled non-blockingly.
        console.error('Failed to create lesson during reschedule. Attempting unwind.', {
          rescheduleId, trainingId, studentId, oldDurationHours, newHoursNeeded: hoursNeeded, error: lessonError,
        })
        const { error: unwindError } = await adminClient.rpc('unwind_reschedule_atomic', {
          p_old_lesson_id: rescheduleId,
          p_training_id: trainingId,
          p_old_duration_hours: oldDurationHours,
          p_new_duration_hours: hoursNeeded,
        })
        if (unwindError) {
          console.error('CRITICAL: unwind_reschedule_atomic failed. Manual reconciliation required.', {
            rescheduleId, trainingId, studentId, oldDurationHours, newHoursNeeded: hoursNeeded, error: unwindError,
          })
        }
        if (teamsMeetingId) {
          try {
            await cancelTeamsMeeting(teamsMeetingId)
          } catch (cancelError) {
            console.error('CRITICAL: orphan Teams meeting after reschedule unwind:', {
              teamsMeetingId, rescheduleId, error: cancelError,
            })
          }
        }
      } else {
        console.error('Failed to create lesson — refunding deducted hours:', lessonError)
        const { error: refundError } = await adminClient.rpc('refund_hours_atomic', {
          p_training_id: trainingId,
          p_hours: hoursNeeded,
        })
        if (refundError) {
          console.error('CRITICAL: refund_hours_atomic failed after lesson insert error:', refundError)
        }
      }
      return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
    }

    if (oldTeamsMeetingId) {
      try {
        await cancelTeamsMeeting(oldTeamsMeetingId)
      } catch (teamsError) {
        console.error('CRITICAL: orphan Teams meeting after student reschedule:', {
          teams_meeting_id: oldTeamsMeetingId,
          lesson_id: rescheduleId,
          error: teamsError,
        })
      }
    }

    // ── 7. Send confirmation emails ───────────────────────────────────────────
    const isReschedule = !!rescheduleId
    const studentTimezone = studentRow.timezone ?? 'Europe/London'
    const teacherTimezone = teacher.timezone ?? 'Africa/Johannesburg'

    const studentDateTime = formatDateTime(startTime.toISOString(), studentTimezone)
    const teacherDateTime = formatDateTime(startTime.toISOString(), teacherTimezone)

    const studentSubject = isReschedule
      ? 'Lingualink Online – Your class has been rescheduled'
      : 'Lingualink Online – Your class is confirmed'

    const studentBodyHtml = isReschedule
      ? rescheduleConfirmationStudentEmail(teacher.full_name, studentDateTime, durationMinutes)
      : bookingConfirmationStudentEmail(teacher.full_name, studentDateTime, durationMinutes)

    const teacherSubject = isReschedule
      ? `Lingualink Online – Class rescheduled by ${studentRow.full_name}`
      : `Lingualink Online – New class booked with ${studentRow.full_name}`

    const teacherBodyHtml = isReschedule
      ? rescheduleConfirmationStudentEmail(studentRow.full_name, teacherDateTime, durationMinutes)
      : bookingNotificationTeacherEmail(studentRow.full_name, teacherDateTime, durationMinutes)

    await Promise.allSettled([
      resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: studentRow.email,
        subject: studentSubject,
        html: buildEmailTemplate({
          recipientName: studentRow.full_name,
          recipientFallback: 'Student',
          subject: studentSubject,
          bodyHtml: studentBodyHtml,
          contactEmail: 'support@lingualinkonline.com',
        }),
      }),
      resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: teacher.email,
        subject: teacherSubject,
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject: teacherSubject,
          bodyHtml: teacherBodyHtml,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      }),
    ])

    revalidatePath('/upcoming-classes')
    revalidatePath('/student/my-classes')
    revalidatePath('/admin/classes')
    // ── 8. Return success ─────────────────────────────────────────────────────
    return NextResponse.json({ success: true, lessonId: newLesson.id })

  } catch (err) {
    console.error('Unexpected error in /api/student/book:', err)
    return NextResponse.json({ error: 'An unexpected error occurred. Please try again.' }, { status: 500 })
  }
}
