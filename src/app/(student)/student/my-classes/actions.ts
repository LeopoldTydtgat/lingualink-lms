'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function cancelLessonAction(lessonId: string) {
  const supabase = await createClient()

  // Get the authenticated student
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()
  if (!student) return { error: 'Student not found' }

  // Get the lesson — confirm it belongs to this student and is not already cancelled
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id, student_id, training_id, scheduled_at, duration_minutes, status')
    .eq('id', lessonId)
    .eq('student_id', student.id)
    .single()

  if (!lesson) return { error: 'Lesson not found' }
  if (lesson.status === 'cancelled') return { error: 'Lesson is already cancelled' }

  // 24-hour rule — check how far away the class is
  const now = new Date()
  const classTime = new Date(lesson.scheduled_at)
  const hoursUntilClass = (classTime.getTime() - now.getTime()) / (1000 * 60 * 60)
  const isRefundable = hoursUntilClass > 24

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
    const hoursToRefund = lesson.duration_minutes / 60

    // Get current hours_consumed
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

  revalidatePath('/student/my-classes')
  return { success: true, refunded: isRefundable }
}