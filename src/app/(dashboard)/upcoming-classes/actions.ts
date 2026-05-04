'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentCancellationByTeacherEmailContent, studentCancellationByAdminEmailContent, teacherCancellationEmailContent } from '@/lib/email/templates'

export async function teacherRescheduleLesson(
  lessonId: string,
  messageToStudent: string
): Promise<{ error?: string }> {
  const supabase = await createClient()
  const adminClient = createAdminClient()

  // Verify caller is an authenticated teacher
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Fetch the lesson — verify it belongs to this teacher
  const { data: lesson, error: lessonError } = await adminClient
    .from('lessons')
    .select('id, teacher_id, student_id, training_id, scheduled_at, duration_minutes, status')
    .eq('id', lessonId)
    .single()

  if (lessonError || !lesson) return { error: 'Lesson not found' }
  if (lesson.teacher_id !== user.id) return { error: 'Not authorised' }
  if (lesson.status !== 'scheduled') return { error: 'This class cannot be rescheduled' }

  // Enforce 24-hour rule server-side
  const hoursUntil = (new Date(lesson.scheduled_at).getTime() - Date.now()) / 1000 / 60 / 60
  if (hoursUntil < 24) return { error: 'You cannot reschedule within 24 hours of the class' }

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

  if (!student) return { error: 'Student not found' }
  if (!student.auth_user_id) {
    console.error('Student has no auth_user_id — cannot send message:', lesson.student_id)
    return { error: 'Student account is not linked to a login. Please contact admin.' }
  }

  // Cancel the lesson
  const { error: cancelError } = await adminClient
    .from('lessons')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: messageToStudent,
    })
    .eq('id', lessonId)

  if (cancelError) return { error: 'Failed to cancel lesson' }

  // Refund hours to training
  if (lesson.training_id) {
    const { data: training } = await adminClient
      .from('trainings')
      .select('hours_consumed')
      .eq('id', lesson.training_id)
      .single()

    if (training) {
      const hoursToRefund = lesson.duration_minutes / 60
      await adminClient
        .from('trainings')
        .update({ hours_consumed: Math.max(0, training.hours_consumed - hoursToRefund) })
        .eq('id', lesson.training_id)
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
      subject: 'Lingualink Online — Your class has been rescheduled by your teacher',
      html: buildEmailTemplate({
        recipientName: student.full_name,
        recipientFallback: 'Student',
        subject: 'Your class has been rescheduled',
        bodyHtml: emailBody,
        contactEmail: 'support@lingualinkonline.com',
      }),
    })
  } catch (emailErr) {
    console.error('Reschedule email failed — lesson still cancelled:', emailErr)
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
  return {}
}
