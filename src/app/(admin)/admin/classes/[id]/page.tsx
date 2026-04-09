import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClassDetailClient from './ClassDetailClient'

export default async function AdminClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) redirect('/dashboard')

  // Fetch lesson with joined teacher, student, and training
  const { data: lessonRaw, error } = await supabase
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

  if (error || !lessonRaw) redirect('/admin/classes')

  // Check if a report exists for this lesson
  const { data: report } = await supabase
    .from('reports')
    .select('id, status')
    .eq('lesson_id', id)
    .maybeSingle()

  // Flatten nested join arrays
  const lesson = {
    ...lessonRaw,
    teacher: Array.isArray(lessonRaw.profiles) ? lessonRaw.profiles[0] : lessonRaw.profiles,
    student: Array.isArray(lessonRaw.students) ? lessonRaw.students[0] : lessonRaw.students,
    training: Array.isArray(lessonRaw.trainings) ? lessonRaw.trainings[0] : lessonRaw.trainings,
    report: report ?? null,
    profiles: undefined,
    students: undefined,
    trainings: undefined,
  }

  return <ClassDetailClient lesson={lesson} />
}
