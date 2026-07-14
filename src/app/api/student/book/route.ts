import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentBookingConfirmationEmailContent,
  teacherNewBookingEmailContent,
  studentRescheduledEmailContent,
  teacherRescheduledEmailContent,
} from '@/lib/email/templates'
import { createTeamsMeeting, cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { BookClassSchema } from '@/lib/validation/schemas'
import { revalidatePath } from 'next/cache'
import { isSlotAvailable } from '@/lib/availability'
import { checkStudentBookingLimit } from '@/lib/rateLimit'
import { requireTz } from '@/lib/time/requireTz'
import { createPendingReport } from '@/lib/reports/createPendingReport'

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
      .select('id, full_name, email, timezone, auth_user_id, profile_completed')
      .eq('id', studentId)
      .single()

    if (studentError || !studentRow) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    if (studentRow.auth_user_id !== user.id) {
      return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
    }

    if (studentRow.profile_completed !== true) {
      return NextResponse.json(
        { error: 'Please confirm your timezone in My Account before booking a class.', code: 'PROFILE_INCOMPLETE' },
        { status: 403 }
      )
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

    // Verify the requested teacher is assigned to this training — assignment check, NEW260.
    // The client only offers assigned teachers, but the API must enforce it too: without
    // this, a student could POST any teacherId and book (or reschedule onto) a teacher who
    // was never assigned to their training. Placed before the fresh-book/reschedule split so
    // the single check gates both branches. adminClient because hours_log/junction reads are
    // service-role here and this must not depend on the student's training_teachers RLS.
    const { data: assignedTeacher, error: assignmentError } = await adminClient
      .from('training_teachers')
      .select('teacher_id')
      .eq('training_id', trainingId)
      .eq('teacher_id', teacherId)
      .maybeSingle()

    if (assignmentError) {
      console.error('training_teachers assignment check failed:', assignmentError)
      return NextResponse.json(
        { error: 'Failed to verify teacher assignment. Please try again.' },
        { status: 500 }
      )
    }

    if (!assignedTeacher) {
      return NextResponse.json(
        { error: 'This teacher is not assigned to your training' },
        { status: 403 }
      )
    }

    // ── 3c. Re-check teacher availability server-side ─────────────────────────
    const slotAvailable = await isSlotAvailable(teacherId, scheduledAt, durationMinutes, adminClient)
    if (!slotAvailable) {
      return NextResponse.json(
        { error: 'This time slot is no longer available. Please pick another.', code: 'SLOT_NOT_AVAILABLE' },
        { status: 409 }
      )
    }

    // ── 4. Load the teacher's profile for emails ──────────────────────────────
    const { data: teacher, error: teacherError } = await adminClient
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
    // Original start time of the rescheduled-from lesson — captured before the RPC
    // cancels it, so the reschedule emails can show "Previous time". Null on a fresh book.
    let oldScheduledAt: string | null = null
    let oldDurationMinutes: number | null = null
    // NEW257: id of the hours_log ledger row inserted by book_class_atomic.
    // Set only on the fresh-book path below; stays null on the reschedule path
    // (which uses reschedule_class_atomic and is not backfilled here).
    let hoursLogId: string | null = null

    if (rescheduleId) {
      const { data: oldLesson, error: oldLessonError } = await adminClient
        .from('lessons')
        .select('duration_minutes, teams_meeting_id, teams_join_url, scheduled_at')
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
      oldScheduledAt = oldLesson.scheduled_at ?? null
      oldDurationMinutes = oldLesson.duration_minutes ?? null

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
      const { data: deductData, error: deductError } = await adminClient.rpc('book_class_atomic', {
        p_training_id: trainingId,
        p_hours_needed: hoursNeeded,
      })
      // NEW257: book_class_atomic now RETURNS the id of the 'class_booking'
      // hours_log row it inserted. Capture it for the lesson_id backfill after
      // the lesson insert succeeds below. (On deductError we return before it is
      // used, so assigning here is safe.)
      hoursLogId = deductData

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

    const { data: newLesson, error: lessonError } = await adminClient
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
      const isSlotConflict = lessonError?.code === '23P01'

      if (rescheduleId) {
        // Reschedule recovery: reschedule_class_atomic has already cancelled
        // the old lesson and applied net delta (new - old) to hours_consumed.
        // unwind_reschedule_atomic restores the old lesson to scheduled and
        // reverses the hours delta in a single transaction. Any orphaned
        // Teams meeting created earlier is cancelled non-blockingly.
        //
        // Note: Teams cols on the old row are intentionally untouched here.
        // reschedule_class_atomic does not modify them, and the original
        // Microsoft meeting is not deleted on the unwind path (only the NEW
        // meeting created at L334-347 is cancelled below). Old row restores
        // to 'scheduled' with its original Teams link intact - the student's
        // working URL survives.
        console.error('Failed to create lesson during reschedule. Attempting unwind.', {
          lesson_id: rescheduleId,
          training_id: trainingId,
          student_id: studentId,
          old_duration_hours: oldDurationHours,
          new_hours_needed: hoursNeeded,
          error: lessonError,
        })
        const { data: unwindRestored, error: unwindError } = await adminClient.rpc('unwind_reschedule_atomic', {
          p_old_lesson_id: rescheduleId,
          p_training_id: trainingId,
          p_old_duration_hours: oldDurationHours,
          p_new_duration_hours: hoursNeeded,
        })
        if (unwindError) {
          console.error('CRITICAL: unwind_reschedule_atomic failed. Manual reconciliation required.', {
            lesson_id: rescheduleId,
            training_id: trainingId,
            student_id: studentId,
            old_duration_hours: oldDurationHours,
            new_hours_needed: hoursNeeded,
            error: unwindError,
          })
        }
        if (teamsMeetingId) {
          try {
            await cancelTeamsMeeting(teamsMeetingId)
          } catch (cancelError) {
            console.error('CRITICAL: orphan Teams meeting after reschedule unwind:', {
              teams_meeting_id: teamsMeetingId,
              lesson_id: rescheduleId,
              error: cancelError,
            })
          }
        }

        if (!unwindError && unwindRestored === false) {
          // Hours were returned, but the original lesson could not be restored
          // (its freed slot was taken). The student has no class now but their
          // hours are back — tell them to rebook.
          return NextResponse.json(
            {
              error: 'RESCHEDULE_FAILED_HOURS_RETURNED',
              message:
                'We could not keep your original class and the new time was no longer available. Your hours have been returned — please book a new class.',
            },
            { status: 409 }
          )
        }

        if (isSlotConflict && !unwindError) {
          // unwindRestored === true: original lesson is back at its original time.
          // The reschedule simply did not go through — original class is intact.
          return NextResponse.json(
            {
              error: 'SLOT_NOT_AVAILABLE',
              message:
                'That time was just booked by someone else. Your original class is unchanged — please choose a different time.',
            },
            { status: 409 }
          )
        }
        // Any other case (unwindError set, or restored but a non-slot insert error)
        // falls through to the generic 500 below; the CRITICAL log above flags
        // genuine unwind failures for manual reconciliation.
      } else {
        if (teamsMeetingId) {
          try {
            await cancelTeamsMeeting(teamsMeetingId)
          } catch (cancelError) {
            console.error('CRITICAL: orphan Teams meeting after fresh-booking insert failure:', {
              teams_meeting_id: teamsMeetingId,
              lesson_id: null,
              error: cancelError,
            })
          }
        }

        console.error('Failed to create lesson — refunding deducted hours:', lessonError)
        const { error: refundError } = await adminClient.rpc('refund_hours_atomic', {
          p_training_id: trainingId,
          p_hours: hoursNeeded,
        })
        if (refundError) {
          console.error('CRITICAL: refund_hours_atomic failed after lesson insert error:', {
            training_id: trainingId,
            student_id: studentId,
            lesson_id: null,
            error: refundError,
          })
        }

        if (isSlotConflict) {
          return NextResponse.json(
            { error: 'SLOT_NOT_AVAILABLE', message: 'This slot was just booked by another student. Please choose a different time.' },
            { status: 409 }
          )
        }
      }
      return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
    }

    // ── 6a. Backfill hours_log.lesson_id (NEW257) ─────────────────────────────
    // book_class_atomic returned the id of the 'class_booking' ledger row; now
    // that the lesson exists, link the two. Fresh-book path only — hoursLogId is
    // null on the reschedule path (reschedule_class_atomic writes its own paired
    // ledger row and is not backfilled here). Non-blocking: the booking already
    // succeeded and the ledger row exists, so a failure only leaves the link
    // unset — log it and continue. Uses adminClient because hours_log grants
    // students SELECT only (RLS would deny a student-session UPDATE).
    if (hoursLogId) {
      const { error: backfillError } = await adminClient
        .from('hours_log')
        .update({ lesson_id: newLesson.id })
        .eq('id', hoursLogId)
      if (backfillError) {
        console.error('[NEW257] hours_log.lesson_id backfill failed (student book):', {
          hours_log_id: hoursLogId,
          lesson_id: newLesson.id,
          error: backfillError,
        })
      }
    }

    // H1i: After successful reschedule, the OLD lesson row (cancelled by
    // reschedule_class_atomic) still holds the deleted meeting's Teams
    // columns. NULL them inline so the row matches its 'cancelled' status.
    //
    // Placement is load-bearing. Do NOT move this UPDATE into the unwind
    // branch above. On the unwind path the original Teams meeting is never
    // deleted (the route only cancels the NEW meeting on unwind), so
    // nulling the old row's Teams cols there would orphan a live meeting
    // in Microsoft with no DB pointer for the sweeper to find.
    if (oldTeamsMeetingId) {
      let graphSucceeded = true
      try {
        await cancelTeamsMeeting(oldTeamsMeetingId)
      } catch (teamsError) {
        graphSucceeded = false
        console.error('CRITICAL: orphan Teams meeting after student reschedule:', {
          teams_meeting_id: oldTeamsMeetingId,
          lesson_id: rescheduleId,
          error: teamsError,
        })
      }

      // Null Teams cols on the old (now cancelled) row.
      // teams_join_url: unconditional. The URL is dead either way (Graph
      //   DELETE succeeded) or unreachable to the user (cancelled status
      //   hides it from all UI gates). Mirrors H1h.
      // teams_meeting_id: only if graphSucceeded. If Graph DELETE failed,
      //   we leave the id set so scripts/cleanup-orphan-teams-meetings.ts
      //   can recover (sweeper predicate: teams_meeting_id IS NOT NULL
      //   AND status IN cancel-family).
      // needs_teams_cleanup: set true ONLY when Graph DELETE failed. The
      //   orphan meeting still lives in M365 and teams_meeting_id is retained
      //   above; this flag is an explicit admin-visible signal so the orphan
      //   row is directly findable. The intended worklist is
      //   needs_teams_cleanup = true AND teams_meeting_id IS NOT NULL (the AND
      //   excludes rows the sweeper later resolves but does not un-flag). That
      //   beats relying solely on CRITICAL #1 in the logs. The sweeper does not
      //   read this column today (it matches on teams_meeting_id +
      //   cancel-status), so the flag is purely additive. On Graph success we
      //   leave the column at its NOT NULL DEFAULT false — nothing to clean up.
      const updatePayload: Record<string, unknown> = {
        teams_join_url: null,
        updated_at: new Date().toISOString(),
      }
      if (graphSucceeded) {
        updatePayload.teams_meeting_id = null
      } else {
        updatePayload.needs_teams_cleanup = true
      }

      const { data: nulled, error: nullError } = await adminClient
        .from('lessons')
        .update(updatePayload)
        .eq('id', rescheduleId)
        .select('id')

      if (nullError) {
        console.error('CRITICAL: failed to null Teams cols on rescheduled-from lesson:', {
          lesson_id: rescheduleId,
          error: nullError,
        })
      } else if (!nulled || nulled.length === 0) {
        // 0 rows matched means the UPDATE itself landed on no row, so neither
        // the null nor the needs_teams_cleanup flag could be persisted
        // anywhere. This is the one orphan scenario the flag cannot capture
        // (nothing was updated); by necessity the CRITICAL log below is the
        // only signal — it cannot self-heal via the same (unmatched) row.
        console.error('CRITICAL: Teams col null UPDATE affected 0 rows:', {
          lesson_id: rescheduleId,
        })
      }
    }

    // ── 6b. Create the paired pending report row (NEW178) ─────────────────────
    // Every lesson gets a 'pending' report the teacher later completes via
    // complete_report_atomic. Non-blocking: the booking must still succeed if
    // this write fails, so we log and continue.
    const classEndsAtIso = new Date(new Date(scheduledAt).getTime() + durationMinutes * 60 * 1000).toISOString()
    const { error: pendingReportError } = await createPendingReport(adminClient, newLesson.id, teacherId, classEndsAtIso)
    if (pendingReportError) {
      console.error('[NEW178] pending report create failed (student book):', {
        lesson_id: newLesson.id,
        error: pendingReportError,
      })
    }

    // ── 7. Send confirmation emails ───────────────────────────────────────────
    const isReschedule = !!rescheduleId
    try {
    const studentTimezone = requireTz(studentRow.timezone, 'book:student')
    const teacherTimezone = requireTz(teacher.timezone, 'book:teacher')

    const newScheduledAtIso = startTime.toISOString()

    const studentSubject = isReschedule
      ? 'Lingualink Online - Your class has been rescheduled'
      : 'Lingualink Online - Your class is confirmed'

    const studentBodyHtml = isReschedule
      ? studentRescheduledEmailContent(teacher.full_name, oldScheduledAt, oldDurationMinutes, newScheduledAtIso, durationMinutes, studentTimezone, 'student')
      : studentBookingConfirmationEmailContent(teacher.full_name, newScheduledAtIso, durationMinutes, studentTimezone)

    const teacherSubject = isReschedule
      ? `Lingualink Online - Class rescheduled by ${studentRow.full_name}`
      : `Lingualink Online - New class booked with ${studentRow.full_name}`

    const teacherBodyHtml = isReschedule
      ? teacherRescheduledEmailContent(studentRow.full_name, oldScheduledAt, oldDurationMinutes, newScheduledAtIso, durationMinutes, teacherTimezone, 'student')
      : teacherNewBookingEmailContent(studentRow.full_name, newScheduledAtIso, durationMinutes, teacherTimezone)

    await Promise.allSettled([
      resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
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
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
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
    } catch (emailErr) {
      console.error('[Email] Booking/reschedule confirmation emails failed - lesson still created:', emailErr)
    }

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
