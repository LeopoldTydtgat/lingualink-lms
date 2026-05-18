'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentCancellationByTeacherEmailContent, studentCancellationByAdminEmailContent, teacherCancellationEmailContent } from '@/lib/email/templates'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import type { CancelResult } from '@/lib/types/cancel'

export async function teacherCancelLesson(
  lessonId: string,
  messageToStudent: string
): Promise<CancelResult> {
  const supabase = await createClient()
  const adminClient = createAdminClient()

  // Verify caller is an authenticated teacher
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Fetch the lesson — verify it belongs to this teacher
  const { data: lesson, error: lessonError } = await adminClient
    .from('lessons')
    .select('id, teacher_id, student_id, training_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', lessonId)
    .single()

  if (lessonError || !lesson) return { success: false, error: 'Lesson not found' }
  if (lesson.teacher_id !== user.id) return { success: false, error: 'Not authorised' }
  if (lesson.status !== 'scheduled') {
    return { success: false, error: 'Lesson cannot be cancelled in its current state', code: 'LESSON_NOT_CANCELLABLE' }
  }

  // Enforce 24-hour rule server-side
  const hoursUntil = (new Date(lesson.scheduled_at).getTime() - Date.now()) / 1000 / 60 / 60
  if (hoursUntil < 24) return { success: false, error: 'You cannot cancel within 24 hours of the class. Please contact admin.' }

  // Get teacher name
  const { data: teacherProfile } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', user.id)
    .single()
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

  // Graph DELETE first — leave teams_meeting_id set if Graph fails so cleanup script can recover
  let graphSucceeded = true
  if (lesson.teams_meeting_id) {
    try {
      await cancelTeamsMeeting(lesson.teams_meeting_id)
    } catch (teamsError) {
      graphSucceeded = false
      console.error('CRITICAL: orphan Teams meeting after teacher cancel:', {
        teams_meeting_id: lesson.teams_meeting_id,
        lesson_id: lessonId,
        error: teamsError,
      })
    }
  }

  // DB UPDATE — null teams_meeting_id only if Graph succeeded (or no meeting existed)
  const updatePayload: Record<string, unknown> = {
    status: 'cancelled_by_teacher',
    cancelled_at: new Date().toISOString(),
    cancellation_reason: messageToStudent,
    cancelled_by: 'teacher',
    teams_join_url: null,
    updated_at: new Date().toISOString(),
  }
  if (graphSucceeded) {
    updatePayload.teams_meeting_id = null
  }

  const { data: updated, error: cancelError } = await adminClient
    .from('lessons')
    .update(updatePayload)
    .eq('id', lessonId)
    .eq('status', 'scheduled')
    .select('id')

  if (cancelError) return { success: false, error: 'Failed to cancel lesson' }
  if (!updated || updated.length === 0) {
    console.error('CRITICAL: cancel UPDATE affected 0 rows:', { lesson_id: lessonId })
    return { success: false, error: 'Failed to cancel lesson' }
  }

  // Refund hours to training — atomic RPC locks the training and the lesson row, checks
  // hours_refunded for idempotency, sets the flag on success, and clamps at zero, all in one txn.
  let refunded = false
  if (lesson.training_id) {
    const { data: refundResult, error: refundError } = await adminClient.rpc('refund_hours_atomic', {
      p_training_id: lesson.training_id,
      p_hours: lesson.duration_minutes / 60,
      p_lesson_id: lesson.id,
    })
    if (refundError) {
      return { success: false, error: 'Failed to refund hours' }
    }
    if (
      refundResult &&
      typeof refundResult === 'object' &&
      'success' in refundResult &&
      (refundResult as { success: boolean }).success === false
    ) {
      const code = (refundResult as { code?: string }).code
      if (code === 'ALREADY_REFUNDED') {
        return { success: false, error: 'This lesson has already been refunded' }
      }
      return { success: false, error: 'Failed to refund hours' }
    }
    if (
      refundResult &&
      typeof refundResult === 'object' &&
      'success' in refundResult &&
      (refundResult as { success: boolean }).success === true
    ) {
      refunded = true
    }
  }

  // Send email to student
  try {
    const hoursRefunded = lesson.duration_minutes / 60
    const emailBody = studentCancellationByTeacherEmailContent(
      teacherName,
      lesson.scheduled_at,
      hoursRefunded,
      student.timezone ?? 'UTC',
      messageToStudent
    )
    await resend.emails.send({
      from: 'no-reply@lingualinkonline.com',
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
  } catch (emailErr) {
    console.error('Cancellation email to student failed — lesson still cancelled:', emailErr)
  }

  // Send confirmation email to the teacher
  try {
    if (teacherProfile?.email) {
      const teacherEmailBody = teacherCancellationEmailContent(
        student.full_name,
        lesson.scheduled_at,
        teacherProfile.timezone ?? 'UTC'
      )
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: teacherProfile.email,
        subject: 'Lingualink Online — Class cancellation confirmed',
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
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return { success: true, refunded }
}
