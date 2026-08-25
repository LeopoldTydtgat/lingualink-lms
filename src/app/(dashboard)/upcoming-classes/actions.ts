'use server'

import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentCancellationByTeacherEmailContent, studentCancellationByAdminEmailContent, teacherCancellationEmailContent } from '@/lib/email/templates'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import type { CancelResult } from '@/lib/types/cancel'
import { requireTz } from '@/lib/time/requireTz'
import * as Sentry from '@sentry/nextjs'

export async function teacherCancelLesson(
  lessonId: string,
  messageToStudent: string
): Promise<CancelResult> {
  const supabase = await createClient()
  const adminClient = createAdminClient()

  // Verify caller is an authenticated teacher
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Fetch the lesson — verify it belongs to this teacher. Read via the RLS-scoped client
  // (not admin) and scope to teacher_id for defense-in-depth, mirroring the student path's
  // .eq('student_id', ...). RLS policy "Teachers see own lessons" (teacher_id = auth.uid())
  // has NO status predicate, so the row returns regardless of status; cancellability is
  // still decided solely by the RPC (the single authority), so no status pre-check here.
  const { data: lesson, error: lessonError } = await supabase
    .from('lessons')
    .select('id, teacher_id, student_id, training_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', lessonId)
    .eq('teacher_id', user.id)
    .maybeSingle()

  if (lessonError || !lesson) return { success: false, error: 'Lesson not found' }
  if (lesson.teacher_id !== user.id) return { success: false, error: 'Not authorised' }

  // Enforce 24-hour rule server-side
  const hoursUntil = (new Date(lesson.scheduled_at).getTime() - Date.now()) / 1000 / 60 / 60
  if (hoursUntil < 24) return { success: false, error: 'You cannot cancel within 24 hours of the class. Please contact admin.' }

  // Get teacher name
  const { data: teacherProfile, error: teacherProfileError } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', user.id)
    .single()
  if (teacherProfileError) {
    console.error('Teacher profile fetch failed in cancel-by-teacher — emails may be skipped:', teacherProfileError)
  }
  const teacherName = teacherProfile?.full_name ?? 'Your teacher'

  // Get student info
  const { data: student } = await adminClient
    .from('students')
    .select('id, full_name, email, timezone, auth_user_id')
    .eq('id', lesson.student_id)
    .single()

  if (!student) return { success: false, error: 'Student not found' }
  if (!student.auth_user_id) {
    console.error('Student has no auth_user_id — cannot send message:', lesson.student_id)
    return { success: false, error: 'Student account is not linked to a login. Please contact admin.' }
  }

  // Cancel atomically — the RPC flips status, nulls teams_join_url, and refunds hours
  // (teacher cancel always refunds) in ONE transaction. It deliberately does NOT touch
  // teams_meeting_id; Graph teardown happens here AFTER the commit.
  const cancelIdempotencyKey = randomUUID()
  const { data: result, error: rpcError } = await adminClient.rpc('cancel_lesson_atomic_keyed', {
    p_lesson_id: lessonId,
    p_cancelled_by: 'teacher',
    p_cancellation_reason: messageToStudent,
    p_should_refund: true,
    p_idempotency_key: cancelIdempotencyKey,
  })
  // An rpcError is a lost round trip, so the cancellation may or may not have
  // committed. The same-key retry IS the probe: ONE more call carrying
  // cancelIdempotencyKey settles it whichever way the first call went. If the
  // first call committed, the replay guard matches the stored key and returns
  // replayed:true with the stored refund outcome - no second cancellation and
  // no second refund. If the first call rolled back, the retry performs the
  // cancellation, which is exactly what the teacher asked for. If a DIFFERENT
  // actor cancelled the lesson in between, the stored key is theirs, not ours,
  // and the function answers LESSON_NOT_CANCELLABLE - a real failure that must
  // stay a failure.
  //
  // No hold-and-raise gate here, unlike the booking and reschedule routes:
  // there, a retry that actually performs the work is a second deduction, so an
  // unresolved probe has to hold. Here a retry that performs the work is the
  // correct result, and this path always refunds, so the key is what prevents a
  // double refund. Only rpcError is retried - a structured { success: false }
  // means the database answered, so nothing is ambiguous and there is nothing
  // to probe. Exactly one attempt, never a loop, never a second key.
  let rpcResult = result
  if (rpcError) {
    const retry = await adminClient.rpc('cancel_lesson_atomic_keyed', {
      p_lesson_id: lessonId,
      p_cancelled_by: 'teacher',
      p_cancellation_reason: messageToStudent,
      p_should_refund: true,
      p_idempotency_key: cancelIdempotencyKey,
    })
    if (retry.error) {
      console.error('CRITICAL: cancel_lesson_atomic_keyed RPC failed after retry', {
        lesson_id: lessonId,
        idempotency_key: cancelIdempotencyKey,
        error: rpcError,
        retry_error: retry.error,
      })
      return { success: false, error: 'Failed to cancel lesson' }
    }
    rpcResult = retry.data
  }
  const r = rpcResult as { success: boolean; code?: string; refunded?: boolean; remaining_hours?: number; replayed?: boolean }
  if (!r.success) {
    if (r.code === 'LESSON_NOT_FOUND') return { success: false, error: 'Lesson not found' }
    if (r.code === 'LESSON_NOT_CANCELLABLE') {
      return { success: false, error: 'This lesson can no longer be cancelled. Please refresh and try again.', code: 'LESSON_NOT_CANCELLABLE' }
    }
    console.error('[teacher cancel] cancel_lesson_atomic_keyed unexpected failure:', { lesson_id: lessonId, code: r.code })
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

  // Send email to student
  try {
    if (student?.email) {
      const hoursRefunded = refunded ? (lesson.duration_minutes / 60) : 0
      const emailBody = studentCancellationByTeacherEmailContent(
        lesson.scheduled_at,
        lesson.duration_minutes,
        hoursRefunded,
        requireTz(student.timezone, 'cancel-by-teacher:student'),
        messageToStudent
      )
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online - Your class has been cancelled by your teacher',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class has been cancelled',
          bodyHtml: emailBody,
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    } else {
      console.error('Student email missing — cancellation email skipped:', { lessonId })
    }
  } catch (emailErr) {
    console.error('Cancellation email to student failed — lesson still cancelled:', emailErr)
    Sentry.captureException(emailErr)
  }

  // Send confirmation email to the teacher
  try {
    if (teacherProfile?.email) {
      const teacherEmailBody = teacherCancellationEmailContent(
        student.full_name,
        lesson.scheduled_at,
        lesson.duration_minutes,
        requireTz(teacherProfile.timezone, 'cancel-by-teacher:teacher'),
        'teacher'
      )
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacherProfile.email,
        subject: 'Lingualink Online - Class cancellation confirmed',
        html: buildEmailTemplate({
          recipientName: teacherName,
          recipientFallback: 'Teacher',
          subject: 'Class cancellation confirmed',
          bodyHtml: teacherEmailBody,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    }
  } catch (teacherEmailErr) {
    console.error('Teacher confirmation email failed — lesson still cancelled:', teacherEmailErr)
    Sentry.captureException(teacherEmailErr)
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return { success: true, refunded }
}
