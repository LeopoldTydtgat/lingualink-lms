import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import EditClassClient from './EditClassClient'

export default async function AdminEditClassPage({
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

  // Fetch lesson with teacher and student names
  const { data: lessonRaw, error } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teacher_id,
      student_id,
      training_id,
      profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        timezone
      ),
      students!lessons_student_id_fkey (
        id,
        full_name
      )
    `)
    .eq('id', id)
    .single()

  if (error || !lessonRaw) redirect('/admin/classes')

  const lesson = {
    ...lessonRaw,
    teacher: Array.isArray(lessonRaw.profiles) ? lessonRaw.profiles[0] : lessonRaw.profiles,
    student: Array.isArray(lessonRaw.students) ? lessonRaw.students[0] : lessonRaw.students,
    profiles: undefined,
    students: undefined,
  }

  // Fetch all active teachers for the reassign dropdown
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .contains('account_types', ['teacher'])
    .eq('is_active', true)
    .order('full_name')

  return (
    <EditClassClient
      lesson={lesson}
      teachers={teachers ?? []}
    />
  )
}
