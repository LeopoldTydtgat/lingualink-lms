'use server'

import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentCancellationByStudentEmailContent,
  teacherCancellationEmailContent,
} from '@/lib/email/templates'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import type { CancelResult } from '@/lib/types/cancel'
import { requireTz } from '@/lib/time/requireTz'

export async function cancelLessonAction(lessonId: string): Promise<CancelResult> {
  const supabase = await createClient()

  // Get the authenticated student
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Get the student record
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, full_name, email, timezone')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  // A read failure and a missing row are different outcomes. Discarding the
  // error collapsed both into null, so a transient fault told an authenticated
  // student their account does not exist. Both still fail closed - no
  // cancellation proceeds - but the student is told which one happened and the
  // real error reaches the logs.
  if (studentError) {
    console.error('[student cancel] students lookup failed:', studentError)
    return { success: false, error: 'Could not verify your account. Please try again.' }
  }
  if (!student) return { success: false, error: 'Student not found' }

  // Get the lesson — confirm it belongs to this student. Cancellability is now decided
  // by the RPC (the single authority), so no status pre-check here.
  const { data: lesson, error: lessonError } = await supabase
    .from('lessons')
    .select('id, student_id, training_id, teacher_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', lessonId)
    .eq('student_id', student.id)
    .maybeSingle()

  // Same split as the students read above. This is the ownership gate, so a
  // read it could not complete must never resolve to "not yours" - fail closed
  // on both, but only the genuinely missing/foreign row says 'Lesson not found'.
  if (lessonError) {
    console.error('[student cancel] lesson lookup failed:', {
      lesson_id: lessonId,
      error: lessonError,
    })
    return { success: false, error: 'Could not load this class. Please try again.' }
  }
  if (!lesson) return { success: false, error: 'Lesson not found' }

  // Fetch teacher profile for email
  const adminClient = createAdminClient()
  const { data: teacher, error: teacherError } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', lesson.teacher_id)
    .maybeSingle()
  // Deliberately NOT a fail-closed gate, unlike the two reads above. This row
  // authorises nothing - it only feeds the notification emails, and that block
  // is already best-effort by design (teacher?.email, wrapped in try/catch) so
  // email trouble can never block a cancellation the student is entitled to.
  // Returning an error here would do exactly that, and would burn the student's
  // >=24h refund window while they retry a fault that is not theirs. So: log it
  // and continue. A null teacher skips the teacher email, which is already
  // today's behaviour when the row is genuinely missing.
  if (teacherError) {
    console.error('[student cancel] teacher profile lookup failed - cancelling anyway, teacher email will be skipped:', {
      teacher_id: lesson.teacher_id,
      lesson_id: lessonId,
      error: teacherError,
    })
  }

  // 24-hour rule — check how far away the class is
  const now = new Date()
  const classTime = new Date(lesson.scheduled_at)
  const hoursUntilClass = (classTime.getTime() - now.getTime()) / (1000 * 60 * 60)
  // >= so exactly 24.0h refunds: the sibling booking/reschedule gates block
  // on < 24, and teacher billability pays cancellations strictly under 24h,
  // so the 24.0 instant belongs to the refundable/>24hr bucket on all sides.
  const isRefundable = hoursUntilClass >= 24
  const hoursToRefund = lesson.duration_minutes / 60

  // Cancel atomically — the RPC flips status, nulls teams_join_url, and conditionally
  // refunds hours in ONE transaction. It deliberately does NOT touch teams_meeting_id;
  // Graph teardown happens here AFTER the commit.
  const cancelIdempotencyKey = randomUUID()
  const { data: result, error: rpcError } = await adminClient.rpc('cancel_lesson_atomic_keyed', {
    p_lesson_id: lessonId,
    p_cancelled_by: 'student',
    p_cancellation_reason: 'Cancelled by student',
    p_should_refund: isRefundable,
    p_idempotency_key: cancelIdempotencyKey,
  })
  // An rpcError is a lost round trip, so the cancellation may or may not have
  // committed. Here the same-key retry IS the probe: ONE more call carrying
  // cancelIdempotencyKey settles it whichever way the first call went. If the
  // first call committed, the replay guard matches the stored key and returns
  // replayed:true with the stored hours_refunded - no second cancellation and
  // no second refund. If the first call rolled back, the retry performs the
  // cancellation, which is exactly the outcome the student asked for. If a
  // DIFFERENT actor cancelled the lesson in between, the stored key is theirs,
  // not ours, and the function answers LESSON_NOT_CANCELLABLE - a real failure
  // that must stay a failure.
  //
  // That is also why there is no hold-and-raise gate here, unlike the booking
  // and reschedule routes: there, a retry that actually performs the work is a
  // second deduction, so an unresolved probe has to hold; here, a retry that
  // actually performs the work is the correct result. Only rpcError is
  // retried - a structured { success: false } means the database answered, so
  // nothing is ambiguous and there is nothing to probe. Exactly one attempt,
  // never a loop, never a second key.
  let rpcResult = result
  if (rpcError) {
    const retry = await adminClient.rpc('cancel_lesson_atomic_keyed', {
      p_lesson_id: lessonId,
      p_cancelled_by: 'student',
      p_cancellation_reason: 'Cancelled by student',
      p_should_refund: isRefundable,
      p_idempotency_key: cancelIdempotencyKey,
    })
    if (retry.error) {
      console.error('CRITICAL: cancel_lesson_atomic_keyed RPC failed after retry', {
        lesson_id: lessonId,
        idempotency_key: cancelIdempotencyKey,
        error: rpcError,
        retry_error: retry.error,
      })
      // BOTH attempts lost their response, so the cancellation may or may not
      // have committed and nothing in hand can say which. 'Failed to cancel'
      // would be a claim about the outcome that this branch cannot make, and
      // a student who reads it as "nothing happened" clicks Cancel again -
      // a fresh key, a genuine second attempt. So the message states the
      // ambiguity as the fact it is and points at the one action that settles
      // it: a refresh shows the true status, from which the student either
      // sees it cancelled or cancels it for real.
      return {
        success: false,
        error: 'We could not confirm whether this class was cancelled. Refresh the page to check before trying again.',
      }
    }
    rpcResult = retry.data
  }
  const r = rpcResult as { success: boolean; code?: string; refunded?: boolean; remaining_hours?: number; replayed?: boolean }
  if (!r.success) {
    if (r.code === 'LESSON_NOT_FOUND') return { success: false, error: 'Lesson not found' }
    if (r.code === 'LESSON_NOT_CANCELLABLE') {
      return { success: false, error: 'This lesson can no longer be cancelled. Please refresh and try again.', code: 'LESSON_NOT_CANCELLABLE' }
    }
    console.error('[student cancel] cancel_lesson_atomic_keyed unexpected failure:', { lesson_id: lessonId, code: r.code })
    return { success: false, error: 'Failed to cancel lesson' }
  }
  const refunded = r.refunded === true

  // DB cancellation is durably committed. Teams teardown is now best-effort and AFTER commit
  // so a Graph failure can never destroy a meeting for a still-scheduled lesson (NEW97).
  if (lesson.teams_meeting_id) {
    try {
      await cancelTeamsMeeting(lesson.teams_meeting_id)
      await adminClient.from('lessons').update({ teams_meeting_id: null }).eq('id', lessonId)
    } catch (teamsError) {
      console.error('Orphan Teams meeting after cancel — sweeper will recover:', {
        teams_meeting_id: lesson.teams_meeting_id,
        lesson_id: lessonId,
        error: teamsError,
      })
    }
  }

  await deleteLessonGoogleEvent(lessonId)

  // Send cancellation emails - failures must not block the cancellation.
  // Each recipient gets its own try/catch and its own timezone guard. They were
  // previously in one block, so a missing or unreadable teacher row - which the
  // teacher read above deliberately tolerates - threw at the teacher guard
  // BEFORE the student send was reached, silently swallowing both emails.
  try {
    const studentTimezone = requireTz(student.timezone, 'cancel-by-student:student')
    await resend.emails.send({
      from: 'Lingualink Online <no-reply@lingualinkonline.com>',
      to: student.email,
      subject: 'Lingualink Online - Your class has been cancelled',
      html: buildEmailTemplate({
        recipientName: student.full_name,
        recipientFallback: 'Student',
        subject: 'Your class has been cancelled',
        bodyHtml: studentCancellationByStudentEmailContent(
          lesson.scheduled_at,
          lesson.duration_minutes,
          refunded ? hoursToRefund : 0,
          studentTimezone
        ),
        contactEmail: 'support@lingualinkonline.com',
      }),
    })
  } catch (emailErr) {
    console.error('[Email] Student cancellation email failed:', { lesson_id: lessonId, error: emailErr })
  }

  if (teacher?.email) {
    try {
      const teacherTimezone = requireTz(teacher.timezone, 'cancel-by-student:teacher')
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: `Lingualink Online - Class cancelled by ${student.full_name}`,
        html: buildEmailTemplate({
          recipientName: teacher.full_name ?? 'Teacher',
          recipientFallback: 'Teacher',
          subject: 'Class cancelled by student',
          bodyHtml: teacherCancellationEmailContent(
            student.full_name,
            lesson.scheduled_at,
            lesson.duration_minutes,
            teacherTimezone,
            'student',
            !isRefundable
          ),
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    } catch (emailErr) {
      console.error('[Email] Teacher cancellation email failed:', { lesson_id: lessonId, teacher_id: lesson.teacher_id, error: emailErr })
    }
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return { success: true, refunded }
}
