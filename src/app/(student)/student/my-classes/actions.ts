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
    .select('id, student_id, training_id, teacher_id, scheduled_at, duration_minutes, status')
    .eq('id', lessonId)
    .eq('student_id', student.id)
    .single()

  if (!lesson) return { error: 'Lesson not found' }
  if (lesson.status === 'cancelled') return { error: 'Lesson is already cancelled' }

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

  // Cancel the lesson
  const { error: cancelError } = await supabase
    .from('lessons')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: 'Cancelled by student',
    })
    .eq('id', lessonId)

  if (cancelError) return { error: 'Failed to cancel lesson' }

  // Refund hours if cancelled more than 24 hours before class
  if (isRefundable) {
    const { data: training } = await supabase
      .from('trainings')
      .select('hours_consumed')
      .eq('id', lesson.training_id)
      .single()

    if (training) {
      const newHoursConsumed = Math.max(0, training.hours_consumed - hoursToRefund)
      await supabase
        .from('trainings')
        .update({ hours_consumed: newHoursConsumed })
        .eq('id', lesson.training_id)
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

  revalidatePath('/student/my-classes')
  return { success: true, refunded: isRefundable }
}
