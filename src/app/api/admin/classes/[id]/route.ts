import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentCancellationByAdminEmailContent, studentRescheduledEmailContent } from '@/lib/email/templates'
import { cancelTeamsMeeting, createTeamsMeeting, updateTeamsMeeting } from '@/lib/microsoft/graph'
import { adminClassesPatchSchema } from '@/lib/validation/schemas'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'
import { localToUtc } from '@/lib/utils/timezone'
import { requireTz } from '@/lib/time/requireTz'

// GET /api/admin/classes/[id]
// Returns full detail for a single lesson including teacher, student, training, and report link
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  const { data: lesson, error } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_at,
      cancellation_reason,
      teams_join_url,
      teams_meeting_id,
      training_id,
      teacher_id,
      student_id,
      created_at,
      updated_at,
      reminder_24_sent,
      reminder_1h_sent,
      profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url,
        timezone
      ),
      students!lessons_student_id_fkey (
        id,
        full_name,
        photo_url,
        timezone
      ),
      trainings!lessons_training_id_fkey (
        id,
        package_name,
        total_hours,
        hours_consumed
      )
    `)
    .eq('id', id)
    .single()

  if (error || !lesson) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  // Check if a report exists for this lesson
  const { data: report } = await supabase
    .from('reports')
    .select('id, status')
    .eq('lesson_id', id)
    .maybeSingle()

  // Flatten nested join arrays
  const result = {
    ...lesson,
    teacher: Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles,
    student: Array.isArray(lesson.students) ? lesson.students[0] : lesson.students,
    training: Array.isArray(lesson.trainings) ? lesson.trainings[0] : lesson.trainings,
    report: report ?? null,
    profiles: undefined,
    students: undefined,
    trainings: undefined,
  }

  return NextResponse.json({ lesson: result })
}

// PATCH /api/admin/classes/[id]
// Admin can edit any class field — no 24hr restriction applies
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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
  const parsed = adminClassesPatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 })
  }
  const fields = parsed.data

  // Fetch the current lesson so we can handle hours adjustments correctly
  const { data: existing, error: fetchError } = await supabase
    .from('lessons')
    .select('id, teacher_id, student_id, training_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  // --- CANCEL action ---
  if (fields.action === 'cancel') {
    const { cancellation_reason, refund_hours } = fields
    const shouldRefund = refund_hours
    const hoursToRefund = existing.duration_minutes / 60
    const adminClient = createAdminClient()

    // Cancel atomically — the RPC flips status, nulls teams_join_url, and conditionally
    // refunds hours (gated on the admin's toggle) in ONE transaction. It is the single
    // authority on cancellability. It deliberately does NOT touch teams_meeting_id;
    // Graph teardown happens here AFTER the commit.
    const { data: result, error: rpcError } = await adminClient.rpc('cancel_lesson_atomic', {
      p_lesson_id: id,
      p_cancelled_by: 'admin',
      p_cancellation_reason: cancellation_reason ?? 'Cancelled by admin',
      p_should_refund: shouldRefund,
    })
    if (rpcError) {
      console.error('CRITICAL: cancel_lesson_atomic RPC failed:', { lesson_id: id, error: rpcError })
      return NextResponse.json({ error: 'Failed to cancel lesson' }, { status: 500 })
    }
    const r = result as { success: boolean; code?: string; refunded?: boolean; remaining_hours?: number }
    if (!r.success) {
      if (r.code === 'LESSON_NOT_FOUND') {
        return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
      }
      if (r.code === 'LESSON_NOT_CANCELLABLE') {
        return NextResponse.json(
          { error: 'This lesson can no longer be cancelled. Please refresh and try again.', code: 'LESSON_NOT_CANCELLABLE' },
          { status: 409 }
        )
      }
      console.error('cancel_lesson_atomic unexpected failure:', { lesson_id: id, code: r.code })
      return NextResponse.json({ error: 'Failed to cancel lesson' }, { status: 500 })
    }
    const refunded = r.refunded === true

    // DB cancellation is durably committed. Teams teardown is now best-effort and AFTER commit
    // so a Graph failure can never destroy a meeting for a still-scheduled lesson (NEW97).
    if (existing.teams_meeting_id) {
      try {
        await cancelTeamsMeeting(existing.teams_meeting_id)
        await adminClient.from('lessons').update({ teams_meeting_id: null }).eq('id', id)
      } catch (teamsError) {
        console.error('Orphan Teams meeting after cancel — sweeper will recover:', {
          teams_meeting_id: existing.teams_meeting_id,
          lesson_id: id,
          error: teamsError,
        })
      }
    }

    // Send cancellation email to student
    try {
      const { data: teacherProfile } = await adminClient
        .from('profiles')
        .select('full_name')
        .eq('id', existing.teacher_id)
        .single()

      const { data: studentData } = await adminClient
        .from('students')
        .select('full_name, email, timezone')
        .eq('id', existing.student_id)
        .single()

      if (studentData?.email) {
        const emailHoursValue = refunded ? hoursToRefund : 0
        const emailBody = studentCancellationByAdminEmailContent(
          teacherProfile?.full_name ?? 'Your teacher',
          existing.scheduled_at,
          emailHoursValue,
          requireTz(studentData.timezone, 'admin-cancel:student'),
          cancellation_reason ?? undefined
        )
        await resend.emails.send({
          from: 'no-reply@lingualinkonline.com',
          to: studentData.email,
          subject: 'Lingualink Online — Your class has been cancelled',
          html: buildEmailTemplate({
            recipientName: studentData.full_name ?? 'Student',
            recipientFallback: 'Student',
            subject: 'Your class has been cancelled',
            bodyHtml: emailBody,
            contactEmail: 'support@lingualinkonline.com',
          }),
        })
      }
    } catch (emailErr) {
      console.error('[Email] Admin cancellation email failed — lesson still cancelled:', emailErr)
    }

    revalidatePath('/upcoming-classes')
    revalidatePath('/student/my-classes')
    revalidatePath('/admin/classes')
    return NextResponse.json({ success: true })
  }

  // --- RESCHEDULE / EDIT action ---
  if (existing.status !== 'scheduled') {
    return NextResponse.json({ error: 'LESSON_NOT_EDITABLE' }, { status: 400 })
  }

  const adminClient = createAdminClient()
  const durationChanged = typeof fields.duration_minutes === 'number' && fields.duration_minutes !== existing.duration_minutes
  const teacherChanged = typeof fields.teacher_id === 'string' && fields.teacher_id !== existing.teacher_id

  // Eligibility gate: when the assignment is actually changing, the new teacher must
  // be an active teacher. status='current' is the canonical active-account gate;
  // is_active is deprecated (CLAUDE.md L135 / JOURNAL Bug 8). Keyed on teacherChanged
  // and placed independently of the scheduled_at block below, so a teacher-only
  // reassignment (no time change) is still validated — and always before the update.
  if (teacherChanged && fields.teacher_id) {
    const { data: candidateTeacher, error: candidateError } = await adminClient
      .from('profiles')
      .select('status, account_types')
      .eq('id', fields.teacher_id)
      .maybeSingle()
    if (candidateError) {
      return NextResponse.json({ error: 'Failed to load teacher', code: 'TEACHER_LOOKUP_FAILED' }, { status: 500 })
    }
    const isEligibleTeacher =
      !!candidateTeacher &&
      candidateTeacher.status === 'current' &&
      Array.isArray(candidateTeacher.account_types) &&
      candidateTeacher.account_types.includes('teacher')
    if (!isEligibleTeacher) {
      return NextResponse.json({ error: 'Target teacher is not an active teacher', code: 'INVALID_TEACHER' }, { status: 400 })
    }
  }

  // Convert naive local scheduled_at to canonical UTC using the target teacher's
  // timezone. The "target" is the new teacher if reassigned, else the current.
  let scheduledAtUtc: string | undefined
  if (fields.scheduled_at !== undefined) {
    const targetTeacherId = fields.teacher_id ?? existing.teacher_id
    const { data: targetTeacherProfile, error: tzError } = await adminClient
      .from('profiles')
      .select('timezone')
      .eq('id', targetTeacherId)
      .maybeSingle()
    if (tzError) {
      return NextResponse.json({ error: 'Failed to load teacher timezone', code: 'TIMEZONE_LOOKUP_FAILED' }, { status: 500 })
    }
    if (!targetTeacherProfile?.timezone) {
      return NextResponse.json({ error: 'Target teacher has no timezone set', code: 'TIMEZONE_MISSING' }, { status: 422 })
    }
    const targetTimezone = targetTeacherProfile.timezone
    scheduledAtUtc = localToUtc(fields.scheduled_at, targetTimezone)

    if (new Date(scheduledAtUtc).getTime() < Date.now()) {
      return NextResponse.json(
        { error: 'Cannot schedule a lesson in the past', code: 'LESSON_IN_PAST' },
        { status: 400 }
      )
    }
  }

  // Duration change is owned by the change_duration_atomic RPC — it locks the
  // training row, re-checks balance, writes hours_consumed and lessons.duration_minutes
  // in a single transaction.
  if (durationChanged) {
    const newDurationMinutes = fields.duration_minutes as number
    const { error: rpcError } = await adminClient.rpc('change_duration_atomic', {
      p_lesson_id: id,
      p_old_duration_minutes: existing.duration_minutes,
      p_new_duration_minutes: newDurationMinutes,
    })

    if (rpcError) {
      const msg = (rpcError.message || '').toLowerCase()
      if (msg.includes('insufficient_hours')) {
        const { data: trainingData } = await adminClient
          .from('trainings')
          .select('total_hours, hours_consumed')
          .eq('id', existing.training_id)
          .single()
        const remaining = trainingData
          ? Number(trainingData.total_hours) - Number(trainingData.hours_consumed)
          : 0
        const required = (newDurationMinutes - existing.duration_minutes) / 60
        const deficit = required - remaining
        return NextResponse.json({ error: 'Insufficient hours', deficit_hours: deficit }, { status: 400 })
      }
      if (msg.includes('lesson_not_editable')) {
        return NextResponse.json({ error: 'Lesson can no longer be edited' }, { status: 400 })
      }
      if (msg.includes('lesson_already_modified')) {
        return NextResponse.json({ error: 'Lesson was modified by another action. Refresh and try again.' }, { status: 409 })
      }
      if (msg.includes('invalid_duration')) {
        return NextResponse.json({ error: 'Invalid duration' }, { status: 400 })
      }
      if (msg.includes('lesson_not_found')) {
        return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
      }
      if (rpcError.code === '23P01') {
        return NextResponse.json({ error: 'SLOT_NOT_AVAILABLE' }, { status: 409 })
      }
      console.error('change_duration_atomic failed:', rpcError)
      return NextResponse.json({ error: 'Failed to change duration' }, { status: 500 })
    }
  }

  // Apply remaining lesson changes (scheduled_at, teacher_id) via adminClient.
  // duration_minutes is owned by the RPC above.
  const timeChanged =
    scheduledAtUtc !== undefined &&
    new Date(scheduledAtUtc).getTime() !== new Date(existing.scheduled_at).getTime()

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (scheduledAtUtc !== undefined) updatePayload.scheduled_at = scheduledAtUtc
  if (fields.teacher_id) updatePayload.teacher_id = fields.teacher_id
  if (timeChanged) {
    updatePayload.reminder_24_sent = false
    updatePayload.reminder_1h_sent = false
  }

  if (Object.keys(updatePayload).length > 1) {
    const { data: updatedRows, error: updateError } = await adminClient
      .from('lessons')
      .update(updatePayload)
      .eq('id', id)
      .select('id')

    if (updateError) {
      if (updateError.code === '23P01') {
        return NextResponse.json(
          { error: 'SLOT_NOT_AVAILABLE', message: 'This slot is no longer available.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
    if (!updatedRows || updatedRows.length === 0) {
      console.error('CRITICAL: lesson UPDATE affected 0 rows:', { lesson_id: id })
      return NextResponse.json({ error: 'Lesson update failed' }, { status: 500 })
    }
  }

  // Fetch student/teacher names once for both the Graph subject and the email body.
  // A failure here only degrades labels; reschedule remains durable.
  let studentName = 'Student'
  let teacherName = 'Teacher'
  let studentEmail: string | null = null
  let studentTimezone = 'UTC'
  let teacherEmail: string | null = null
  let teacherTimezone = 'UTC'
  try {
    const [studentRes, teacherRes] = await Promise.all([
      adminClient.from('students').select('full_name, email, timezone').eq('id', existing.student_id).maybeSingle(),
      adminClient.from('profiles').select('full_name, email, timezone').eq('id', existing.teacher_id).maybeSingle(),
    ])
    if (studentRes.data) {
      studentName = studentRes.data.full_name ?? 'Student'
      studentEmail = studentRes.data.email ?? null
      studentTimezone = studentRes.data.timezone ?? 'UTC'
    }
    if (teacherRes.data) {
      teacherName = teacherRes.data.full_name ?? 'Teacher'
      teacherEmail = teacherRes.data.email ?? null
      teacherTimezone = teacherRes.data.timezone ?? 'UTC'
    }
  } catch (nameFetchError) {
    console.warn('Reschedule name fetch failed, using fallbacks', { lesson_id: id, error: nameFetchError })
  }

  // If the teacher was reassigned, swap the teacher-side context to the NEW
  // teacher so the Graph subject, student email teacherName, and teacher
  // email recipient all reference the new teacher. The old teacher is no
  // longer involved with this lesson and receives no notification.
  if (teacherChanged && fields.teacher_id) {
    try {
      const { data: newTeacherRes } = await adminClient
        .from('profiles')
        .select('full_name, email, timezone')
        .eq('id', fields.teacher_id)
        .maybeSingle()
      if (newTeacherRes) {
        teacherName = newTeacherRes.full_name ?? 'Teacher'
        teacherEmail = newTeacherRes.email ?? null
        teacherTimezone = newTeacherRes.timezone ?? 'UTC'
      }
    } catch (newTeacherFetchError) {
      console.warn('New teacher fetch failed after reassign, using fallbacks', { lesson_id: id, new_teacher_id: fields.teacher_id, error: newTeacherFetchError })
    }
  }

  // Sync the Teams meeting when time or duration changes.
  // updateTeamsMeeting preserves the join URL; teacher-only swaps skip Graph entirely.
  // Graph + email templates require canonical UTC; existing.scheduled_at already is.
  const newScheduledAt = scheduledAtUtc ?? existing.scheduled_at
  const newDuration = (fields.duration_minutes as number | undefined) ?? existing.duration_minutes
  const needsGraphUpdate = timeChanged || durationChanged || teacherChanged

  if (needsGraphUpdate) {
    if (existing.teams_meeting_id) {
      try {
        await updateTeamsMeeting({
          meetingId: existing.teams_meeting_id,
          startTime: newScheduledAt,
          durationMinutes: newDuration,
        })
      } catch (graphError) {
        console.warn('Teams calendar time desync — meeting update failed; join URL unaffected, emails carry correct time', { teams_meeting_id: existing.teams_meeting_id, lesson_id: id, error: graphError })
      }
    } else {
      try {
        const meeting = await createTeamsMeeting({
          subject: `Lingualink class – ${studentName} with ${teacherName}`,
          startTime: newScheduledAt,
          durationMinutes: newDuration,
        })
        const { data: persisted, error: graphUpdateError } = await adminClient
          .from('lessons')
          .update({ teams_meeting_id: meeting.meetingId, teams_join_url: meeting.joinUrl })
          .eq('id', id)
          .select('id')
        // Treat a DB error OR a 0-row match as a persist failure. Either way the
        // lesson row keeps teams_meeting_id NULL + status 'scheduled', which the
        // orphan sweeper can never see (its predicate needs a non-null id on a
        // cancel-family row). The just-created Microsoft meeting would then leak
        // with no DB pointer. Delete it now: the lesson is already link-less in
        // this failure (same as the pre-fix state), so this only removes the leak.
        if (graphUpdateError || !persisted || persisted.length === 0) {
          try {
            await cancelTeamsMeeting(meeting.meetingId)
            console.error('CRITICAL: Teams meeting created but DB persist failed — orphan cleaned', {
              teams_meeting_id: meeting.meetingId,
              lesson_id: id,
              error: graphUpdateError ?? null,
            })
          } catch (cleanupError) {
            console.error('CRITICAL: Teams meeting created, DB persist failed, and cleanup delete failed — true orphan remains', {
              teams_meeting_id: meeting.meetingId,
              lesson_id: id,
              error: cleanupError,
            })
          }
        }
      } catch (graphError) {
        console.error('CRITICAL: Teams meeting orphan fallback creation failed', { lesson_id: id, error: graphError })
      }
    }
  }

  if (needsGraphUpdate) {
    if (!studentEmail) {
      console.warn('Reschedule email skipped: student has no email', { lesson_id: id })
    } else {
      try {
        const emailBody = studentRescheduledEmailContent(
          teacherName,
          timeChanged ? existing.scheduled_at : null,
          newScheduledAt,
          newDuration,
          studentTimezone
        )
        await resend.emails.send({
          from: 'no-reply@lingualinkonline.com',
          to: studentEmail,
          subject: 'Lingualink Online — Your class has been rescheduled',
          html: buildEmailTemplate({
            recipientName: studentName,
            recipientFallback: 'Student',
            subject: 'Your class has been rescheduled',
            bodyHtml: emailBody,
            contactEmail: 'support@lingualinkonline.com',
          }),
        })
      } catch (emailErr) {
        console.error('[Email] Reschedule email failed — lesson still updated:', emailErr)
      }
    }
  }

  if (needsGraphUpdate) {
    if (!teacherEmail) {
      console.warn('Reschedule email skipped: teacher has no email', { lesson_id: id })
    } else {
      try {
        const emailBody = studentRescheduledEmailContent(
          studentName,
          timeChanged ? existing.scheduled_at : null,
          newScheduledAt,
          newDuration,
          teacherTimezone
        )
        await resend.emails.send({
          from: 'no-reply@lingualinkonline.com',
          to: teacherEmail,
          subject: 'Lingualink Online — Your class has been rescheduled',
          html: buildEmailTemplate({
            recipientName: teacherName,
            recipientFallback: 'Teacher',
            subject: 'Your class has been rescheduled',
            bodyHtml: emailBody,
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
      } catch (emailErr) {
        console.error('CRITICAL: [Email] Teacher reschedule email failed — lesson still updated:', emailErr)
      }
    }
  }

  if (durationChanged || teacherChanged) {
    const teachersToRecompute: string[] = [existing.teacher_id]
    if (teacherChanged && fields.teacher_id) {
      teachersToRecompute.push(fields.teacher_id)
    }
    const recomputeResults = await Promise.allSettled(
      teachersToRecompute.map(tid => recomputeInvoiceAmountsForTeacher(tid))
    )
    recomputeResults.forEach((r, idx) => {
      if (r.status === 'rejected') {
        console.error('CRITICAL: recomputeInvoiceAmountsForTeacher failed:', { lesson_id: id, teacher_id: teachersToRecompute[idx], error: r.reason })
      }
    })
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return NextResponse.json({ success: true })
}

// DELETE /api/admin/classes/[id]
// Hard-deletes a lesson record. Only allowed when status is cancelled.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  const adminClient = createAdminClient()

  const { data: lesson, error: fetchError } = await adminClient
    .from('lessons')
    .select('id, status')
    .eq('id', id)
    .single()

  if (fetchError || !lesson) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  const cancelledStatuses = ['cancelled', 'cancelled_by_student', 'cancelled_by_teacher']
  if (!cancelledStatuses.includes(lesson.status)) {
    return NextResponse.json({ error: 'Only cancelled classes can be deleted. Please cancel the class first.' }, { status: 422 })
  }

  const { error: deleteError } = await adminClient
    .from('lessons')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return NextResponse.json({ success: true })
}
