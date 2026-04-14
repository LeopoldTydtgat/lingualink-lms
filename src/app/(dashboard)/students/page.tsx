import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StudentsClient from './StudentsClient'

export default async function StudentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get current user's profile to check role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'

  // Fetch trainings with joined student and teacher info
  // Admin sees all trainings. Teacher sees only their own.
  let query = supabase
    .from('trainings')
    .select(`
      id,
      status,
      total_hours,
      hours_consumed,
      start_date,
      end_date,
      package_type,
      teacher_id,
      students (
        id,
        full_name,
        photo_url,
        self_reported_level
      ),
      profiles!trainings_teacher_id_fkey (
        id,
        full_name
      )
    `)
    .order('start_date', { ascending: false })

  if (!isAdmin) {
    query = query.eq('teacher_id', user.id)
  }

  const { data: trainings, error } = await query

  if (error) {
    console.error('Error fetching trainings:', error)
  }

  // Supabase returns nested joins as arrays â€” flatten students and profiles to single objects
  const flatTrainings = (trainings ?? []).map(t => ({
    ...t,
    students: Array.isArray(t.students) ? t.students[0] : t.students,
    profiles: Array.isArray(t.profiles) ? t.profiles[0] : t.profiles,
  }))

  // Split into current and past
  const currentTrainings = flatTrainings.filter(t => t.status === 'active')
  const pastTrainings = flatTrainings.filter(t => t.status !== 'active')

  return (
    <StudentsClient
      currentTrainings={currentTrainings}
      pastTrainings={pastTrainings}
      isAdmin={isAdmin}
    />
  )
}
