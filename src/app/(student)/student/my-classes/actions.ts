'use server'

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
import { isCancelledStatus } from '@/lib/billing/billability'

export async function cancelLessonAction(lessonId: string) {
  const supabase = await createClient()

  // Get the authenticated student
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, timezone')
    .eq('auth_user_id', user.id)
    .single()
  if (!student) return { error: 'Student not found' }

  // Get the lesson — confirm it belongs to this student and is not already cancelled
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id, student_id, training_id, teacher_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', lessonId)
    .eq('student_id', student.id)
    .single()

  if (!lesson) return { error: 'Lesson not found' }
  if (isCancelledStatus(lesson.status)) return { error: 'Lesson is already cancelled' }

  // Fetch teacher profile for email
  const adminClient = createAdminClient()
  const { data: teacher } = await adminClient
    .from('profiles')
    .select('full_name, email, timezone')
    .eq('id', lesson.teacher_id)
    .single()

  // 24-hour rule — check how far away the class is
  const now = new Date()
  const classTime = new Date(lesson.scheduled_at)
  const hoursUntilClass = (classTime.getTime() - now.getTime()) / (1000 * 60 * 60)
  const isRefundable = hoursUntilClass > 24
  const hoursToRefund = lesson.duration_minutes / 60

  // Graph DELETE first — leave teams_meeting_id set if Graph fails so cleanup script can recover
  let graphSucceeded = true
  if (lesson.teams_meeting_id) {
    try {
      await cancelTeamsMeeting(lesson.teams_meeting_id)
    } catch (teamsError) {
      graphSucceeded = false
      console.error('CRITICAL: orphan Teams meeting after student cancel:', {
        teams_meeting_id: lesson.teams_meeting_id,
        lesson_id: lessonId,
        error: teamsError,
      })
    }
  }

  // DB UPDATE — null teams_meeting_id only if Graph succeeded (or no meeting existed)
  const updatePayload: Record<string, unknown> = {
    status: 'cancelled_by_student',
    cancelled_at: new Date().toISOString(),
    cancellation_reason: 'Cancelled by student',
    cancelled_by: 'student',
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
    .select('id')

  if (cancelError) return { error: 'Failed to cancel lesson' }
  if (!updated || updated.length === 0) {
    console.error('CRITICAL: cancel UPDATE affected 0 rows:', { lesson_id: lessonId })
    return { error: 'Failed to cancel lesson' }
  }

  // Refund hours to training — atomic RPC locks the training row, clamps at zero, and writes in one txn.
  if (isRefundable && lesson.training_id) {
    const { error: refundError } = await adminClient.rpc('refund_hours_atomic', {
      p_training_id: lesson.training_id,
      p_hours: hoursToRefund,
    })
    if (refundError) {
      console.error('CRITICAL: refund_hours_atomic RPC failed after student cancel:', {
        lesson_id: lessonId,
        training_id: lesson.training_id,
        error: refundError,
      })
      return { error: 'Failed to refund hours' }
    }
  }

  // Send cancellation emails — failures must not block the cancellation
  try {
    const studentTimezone = student.timezone ?? 'Europe/London'
    const teacherTimezone = teacher?.timezone ?? 'Africa/Johannesburg'

    const emailPromises: Promise<unknown>[] = [
      resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: student.email,
        subject: 'Lingualink Online — Your class has been cancelled',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class has been cancelled',
          bodyHtml: studentCancellationByStudentEmailContent(
            teacher?.full_name ?? 'Your teacher',
            lesson.scheduled_at,
            isRefundable ? hoursToRefund : 0,
            studentTimezone
          ),
          contactEmail: 'support@lingualinkonline.com',
        }),
      }),
    ]

    if (teacher?.email) {
      emailPromises.push(
        resend.emails.send({
          from: 'no-reply@lingualinkonline.com',
          to: teacher.email,
          subject: `Lingualink Online — Class cancelled by ${student.full_name}`,
          html: buildEmailTemplate({
            recipientName: teacher.full_name ?? 'Teacher',
            recipientFallback: 'Teacher',
            subject: 'Class cancelled by student',
            bodyHtml: teacherCancellationEmailContent(
              student.full_name,
              lesson.scheduled_at,
              teacherTimezone
            ),
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
      )
    }

    await Promise.allSettled(emailPromises)
  } catch (emailErr) {
    console.error('[Email] Cancellation emails failed:', emailErr)
  }

  revalidatePath('/upcoming-classes')
  revalidatePath('/student/my-classes')
  revalidatePath('/admin/classes')
  return { success: true, refunded: isRefundable }
}
