import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReportsClient from './ReportsClient'

export default async function ReportsPage() {
  const supabase = await createClient()

  // Check the user is logged in
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get the teacher's profile to check their role
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  const isAdmin = profile.role === 'admin'

  // Fetch reports with lesson and student details joined
  // Admins get all reports, teachers get only their own
  const query = supabase
    .from('reports')
    .select(`
      id,
      status,
      did_class_happen,
      no_show_type,
      feedback_text,
      deadline_at,
      completed_at,
      flagged_at,
      created_at,
      lesson:lessons (
        id,
        scheduled_at,
        duration_minutes,
        student:students (
          id,
          full_name,
          photo_url
        ),
        teacher:profiles (
          id,
          full_name
        )
      )
    `)
    .order('created_at', { ascending: false })

  // If not admin, filter to own reports only
  if (!isAdmin) {
    query.eq('teacher_id', user.id)
  }

  const { data: reports, error } = await query

  if (error) {
    console.error('Error fetching reports:', error)
  }

  return (
    <ReportsClient
      reports={reports ?? []}
      profile={profile}
      isAdmin={isAdmin}
    />
  )
}