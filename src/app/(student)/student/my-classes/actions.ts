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
import type { CancelResult } from '@/lib/types/cancel'
import { requireTz } from '@/lib/time/requireTz'

export async function cancelLessonAction(lessonId: string): Promise<CancelResult> {
  const supabase = await createClient()

  // Get the authenticated student
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, timezone')
    .eq('auth_user_id', user.id)
    .single()
  if (!student) return { success: false, error: 'Student not found' }

  // Get the lesson — confirm it belongs to this student. Cancellability is now decided
  // by the RPC (the single authority), so no status pre-check here.
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id, student_id, training_id, teacher_id, scheduled_at, duration_minutes, status, teams_meeting_id')
    .eq('id', lessonId)
    .eq('student_id', student.id)
    .single()

  if (!lesson) return { success: false, error: 'Lesson not found' }

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

  // Cancel atomically — the RPC flips status, nulls teams_join_url, and conditionally
  // refunds hours in ONE transaction. It deliberately does NOT touch teams_meeting_id;
  // Graph teardown happens here AFTER the commit.
  const { data: result, error: rpcError } = await adminClient.rpc('cancel_lesson_atomic', {
    p_lesson_id: lessonId,
    p_cancelled_by: 'student',
    p_cancellation_reason: 'Cancelled by student',
    p_should_refund: isRefundable,
  })
  if (rpcError) {
    console.error('CRITICAL: cancel_lesson_atomic RPC failed:', { lesson_id: lessonId, error: rpcError })
    return { success: false, error: 'Failed to cancel lesson' }
  }
  const r = result as { success: boolean; code?: string; refunded?: boolean; remaining_hours?: number }
  if (!r.success) {
    if (r.code === 'LESSON_NOT_FOUND') return { success: false, error: 'Lesson not found' }
    if (r.code === 'LESSON_NOT_CANCELLABLE') {
      return { success: false, error: 'This lesson can no longer be cancelled. Please refresh and try again.', code: 'LESSON_NOT_CANCELLABLE' }
    }
    console.error('cancel_lesson_atomic unexpected failure:', { lesson_id: lessonId, code: r.code })
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

  // Send cancellation emails — failures must not block the cancellation
  try {
    const studentTimezone = requireTz(student.timezone, 'cancel-by-student:student')
    const teacherTimezone = requireTz(teacher?.timezone, 'cancel-by-student:teacher')

    const emailPromises: Promise<unknown>[] = [
      resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online - Your class has been cancelled',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class has been cancelled',
          bodyHtml: studentCancellationByStudentEmailContent(
            teacher?.full_name ?? 'Your teacher',
            lesson.scheduled_at,
            lesson.duration_minutes,
            refunded ? hoursToRefund : 0,
            studentTimezone
          ),
          contactEmail: 'support@lingualinkonline.com',
        }),
      }),
    ]

    if (teacher?.email) {
      emailPromises.push(
        resend.emails.send({
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
  return { success: true, refunded }
}
