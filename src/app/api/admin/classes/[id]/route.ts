import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/auth/requireStaff'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentCancellationByAdminEmailContent, studentRescheduledEmailContent, teacherRescheduledEmailContent, teacherCancellationEmailContent } from '@/lib/email/templates'
import { cancelTeamsMeeting, createTeamsMeeting, updateTeamsMeeting } from '@/lib/microsoft/graph'
import { adminClassesPatchSchema } from '@/lib/validation/schemas'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'
import { getBillability, isCancelledStatus } from '@/lib/billing/billability'
import { localToUtc } from '@/lib/utils/timezone'
import { requireTz } from '@/lib/time/requireTz'
import * as Sentry from '@sentry/nextjs'

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

  const staffUser = await requireStaff()
  if (!staffUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

  const staffUser = await requireStaff()
  if (!staffUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

    // Resolve teacher + student once, ahead of both cancellation-email blocks below —
    // mirrors the reschedule branch's up-front fetch. Widened to include teacher
    // email/timezone (previously full_name-only) so the teacher block below needs
    // no second round-trip.
    const { data: teacherProfile } = await adminClient
      .from('profiles')
      .select('full_name, email, timezone')
      .eq('id', existing.teacher_id)
      .single()

    const { data: studentData } = await adminClient
      .from('students')
      .select('full_name, email, timezone')
      .eq('id', existing.student_id)
      .single()

    // Send cancellation email to student
    try {
      if (studentData?.email) {
        const emailHoursValue = refunded ? hoursToRefund : 0
        const emailBody = studentCancellationByAdminEmailContent(
          teacherProfile?.full_name ?? 'Your teacher',
          existing.scheduled_at,
          existing.duration_minutes,
          emailHoursValue,
          requireTz(studentData.timezone, 'admin-cancel:student'),
          cancellation_reason ?? undefined
        )
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: studentData.email,
          subject: 'Lingualink Online - Your class has been cancelled',
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
      Sentry.captureException(emailErr)
    }

    // Send cancellation email to teacher
    try {
      if (teacherProfile?.email) {
        const teacherEmailBody = teacherCancellationEmailContent(
          studentData?.full_name ?? 'Student',
          existing.scheduled_at,
          existing.duration_minutes,
          requireTz(teacherProfile.timezone, 'admin-cancel:teacher'),
          cancellation_reason ?? undefined
        )
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacherProfile.email,
          subject: 'Lingualink Online - Your class has been cancelled',
          html: buildEmailTemplate({
            recipientName: teacherProfile.full_name ?? 'Teacher',
            recipientFallback: 'Teacher',
            subject: 'Class cancelled',
            bodyHtml: teacherEmailBody,
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
      }
    } catch (emailErr) {
      console.error('[Email] Admin cancellation teacher email failed — lesson still cancelled:', emailErr)
      Sentry.captureException(emailErr)
    }

    revalidatePath('/upcoming-classes')
    revalidatePath('/student/my-classes')
    revalidatePath('/admin/classes')
    return NextResponse.json({ success: true })
  }

  // --- RESCHEDULE / EDIT action ---
  if (existing.status !== 'scheduled') {
    return NextResponse.json(
      { error: 'LESSON_NOT_EDITABLE', message: 'This class can no longer be edited because it is cancelled or already completed.' },
      { status: 400 }
    )
  }

  const adminClient = createAdminClient()
  const durationChanged = typeof fields.duration_minutes === 'number' && fields.duration_minutes !== existing.duration_minutes
  const teacherChanged = typeof fields.teacher_id === 'string' && fields.teacher_id !== existing.teacher_id

  // Eligibility gate: when the assignment is actually changing, the new teacher must
  // be an active teacher. status='current' is the canonical active-account gate
  // (CLAUDE.md L135 / JOURNAL Bug 8). Keyed on teacherChanged and placed
  // independently of the scheduled_at block below, so a teacher-only
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

  // Resolve participant names/emails/timezones up front — hoisted ABOVE the duration
  // RPC, lesson UPDATE, Graph sync, emails, and invoice recompute so a missing timezone
  // aborts the reschedule pre-commit instead of half-applying it. Timezone is non-null by
  // schema (post-S111): a null here is a real violation and fails closed below. Names are
  // label-only and degrade to placeholders.
  let studentName = 'Student'
  let teacherName = 'Teacher'
  let studentEmail: string | null = null
  let studentTimezone: string | null = null
  let teacherEmail: string | null = null
  let teacherTimezone: string | null = null
  try {
    const [studentRes, teacherRes] = await Promise.all([
      adminClient.from('students').select('full_name, email, timezone').eq('id', existing.student_id).maybeSingle(),
      adminClient.from('profiles').select('full_name, email, timezone').eq('id', existing.teacher_id).maybeSingle(),
    ])
    if (studentRes.data) {
      studentName = studentRes.data.full_name ?? 'Student'
      studentEmail = studentRes.data.email ?? null
      studentTimezone = studentRes.data.timezone ?? null
    }
    if (teacherRes.data) {
      teacherName = teacherRes.data.full_name ?? 'Teacher'
      teacherEmail = teacherRes.data.email ?? null
      teacherTimezone = teacherRes.data.timezone ?? null
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
        teacherTimezone = newTeacherRes.timezone ?? null
      }
    } catch (newTeacherFetchError) {
      console.warn('New teacher fetch failed after reassign, using fallbacks', { lesson_id: id, new_teacher_id: fields.teacher_id, error: newTeacherFetchError })
    }
  }

  // Fail closed: a null participant timezone (schema violation) aborts the reschedule
  // before any write — never silently default to a wrong zone (which mis-renders the
  // email times). error holds the human message; this endpoint's client renders it.
  let studentTz: string
  let teacherTz: string
  try {
    studentTz = requireTz(studentTimezone, 'admin-reschedule:student')
    teacherTz = requireTz(teacherTimezone, 'admin-reschedule:teacher')
  } catch {
    return NextResponse.json(
      { error: 'Cannot reschedule: a participant timezone is not set.', code: 'TIMEZONE_MISSING' },
      { status: 422 }
    )
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

  // timeChanged gates the reschedule emails below and (with durationChanged /
  // teacherChanged) the atomic RPC call.
  const timeChanged =
    scheduledAtUtc !== undefined &&
    new Date(scheduledAtUtc).getTime() !== new Date(existing.scheduled_at).getTime()

  // The admin_edit_lesson_atomic RPC owns ALL lesson field writes — it locks the
  // training row, re-checks balance, and applies duration_minutes, scheduled_at,
  // teacher_id, the reminder_24_sent/reminder_1h_sent resets, and the NEW341
  // rescheduled_by/rescheduled_at stamps in ONE transaction. Hours movement +
  // hours_log write fire only when the duration actually changed; reminder resets
  // and reschedule stamps only when the time actually moved (IS DISTINCT FROM
  // inside the function). Nothing below re-applies any of those fields.
  if (durationChanged || timeChanged || teacherChanged) {
    const newDurationMinutes = fields.duration_minutes ?? existing.duration_minutes
    const { error: rpcError } = await adminClient.rpc('admin_edit_lesson_atomic', {
      p_lesson_id: id,
      p_old_duration_minutes: existing.duration_minutes,
      p_new_duration_minutes: newDurationMinutes,
      p_created_by: user.id,
      p_new_scheduled_at: scheduledAtUtc ?? null,
      p_new_teacher_id: teacherChanged ? fields.teacher_id : null,
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
        return NextResponse.json(
          { error: 'SLOT_NOT_AVAILABLE', message: 'This slot is no longer available.' },
          { status: 409 }
        )
      }
      console.error('admin_edit_lesson_atomic failed:', rpcError)
      return NextResponse.json({ error: 'Failed to change duration' }, { status: 500 })
    }
  }

  // Sync the Teams meeting when time or duration changes.
  // updateTeamsMeeting preserves the join URL; teacher-only swaps skip Graph entirely.
  // Graph + email templates require canonical UTC; existing.scheduled_at already is.
  const newScheduledAt = scheduledAtUtc ?? existing.scheduled_at
  const newDuration = (fields.duration_minutes as number | undefined) ?? existing.duration_minutes
  const needsGraphUpdate = timeChanged || durationChanged || teacherChanged
  // The reschedule email fires ONLY when the class time actually changed. needsGraphUpdate
  // also covers duration and teacher changes (the Teams meeting must resync for those), but
  // neither should email: the template says "has been rescheduled", which misreads when the
  // time is unchanged. Duration-only changes are visible in-portal (hours log + class card);
  // teacher-only swaps are silent by product decision (Shannon notifies the student directly,
  // and the class still shows in their portal with the same time and join link).

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
          subject: `LinguaLink class – ${studentName} with ${teacherName}`,
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

  if (timeChanged) {
    if (!studentEmail) {
      console.warn('Reschedule email skipped: student has no email', { lesson_id: id })
    } else {
      try {
        const emailBody = studentRescheduledEmailContent(
          teacherName,
          existing.scheduled_at,
          existing.duration_minutes,
          newScheduledAt,
          newDuration,
          studentTz,
          'admin'
        )
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: studentEmail,
          subject: 'Lingualink Online - Your class has been rescheduled',
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
        Sentry.captureException(emailErr)
      }
    }
  }

  if (timeChanged) {
    if (!teacherEmail) {
      console.warn('Reschedule email skipped: teacher has no email', { lesson_id: id })
    } else {
      try {
        const emailBody = teacherRescheduledEmailContent(
          studentName,
          existing.scheduled_at,
          existing.duration_minutes,
          newScheduledAt,
          newDuration,
          teacherTz,
          'admin'
        )
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacherEmail,
          subject: 'Lingualink Online - Your class has been rescheduled',
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
        Sentry.captureException(emailErr)
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

  const staffUser = await requireStaff()
  if (!staffUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const adminClient = createAdminClient()

  const { data: lesson, error: fetchError } = await adminClient
    .from('lessons')
    .select('id, status, scheduled_at, cancelled_at, cancelled_by, rescheduled_by, student_id')
    .eq('id', id)
    .single()

  if (fetchError || !lesson) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  if (!isCancelledStatus(lesson.status)) {
    return NextResponse.json({ error: 'Only cancelled classes can be deleted. Please cancel the class first.' }, { status: 422 })
  }

  // NEW106: A cancelled lesson can still be billable to the B2B company (a <24h cancellation,
  // or a 24-48h cancellation under a 48hr-policy student). The company-billing CSV export reads
  // these exact rows to invoice the company, so hard-deleting one silently drops a billable line
  // item. We block deletion using getBillability(), whose billable predicate for the cancelled
  // statuses reachable here equals the company-billing export's computation, so this guard blocks
  // precisely the rows the export would bill. (This guard and both company-billing exports all call
  // the same threaded getBillability — no inline copy exists.) Clean >24h cancellations and
  // teacher-cancellations are not billable to the company and remain deletable.
  const { data: student } = await adminClient
    .from('students')
    .select('cancellation_policy')
    .eq('id', lesson.student_id)
    .maybeSingle()
  const policy = student?.cancellation_policy ?? '24hr'
  const { billableToTeacher, billable48hr } = getBillability({
    status: lesson.status,
    scheduledAt: lesson.scheduled_at,
    cancelledAt: lesson.cancelled_at,
    cancellationPolicy: policy,
    hourlyRate: 0,        // irrelevant: the billable booleans do not depend on rate/duration
    durationMinutes: 0,
    cancelledBy: lesson.cancelled_by ?? null,
    rescheduledBy: lesson.rescheduled_by ?? null,
  })
  if (billableToTeacher || billable48hr) {
    return NextResponse.json(
      {
        error: 'This cancelled class is billable to the company and cannot be deleted, because it is needed for company invoicing. Late cancellations within the billing window must stay on record.',
        code: 'LESSON_BILLABLE_TO_COMPANY',
      },
      { status: 422 }
    )
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
