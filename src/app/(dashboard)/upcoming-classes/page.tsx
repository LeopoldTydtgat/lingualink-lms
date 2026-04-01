import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import UpcomingClassesClient from './UpcomingClassesClient'

// This is the server component — it fetches data from Supabase,
// then passes it down to the client component for display
export default async function UpcomingClassesPage() {
  const supabase = await createClient()

  // Get the currently logged-in user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get the user's profile (we need their role and name)
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // Fetch all upcoming classes for this teacher
  // We join students so we get the student's name and photo in one query
  const { data: classes, error } = await supabase
    .from('classes')
    .select(`
      id,
      starts_at,
      ends_at,
      status,
      teams_link,
      lesson_notes,
      student:students (
        id,
        full_name,
        photo_url
      )
    `)
    .eq('teacher_id', user.id)
    .eq('status', 'scheduled')
    .gte('starts_at', new Date().toISOString()) // only future classes
    .order('starts_at', { ascending: true })

  if (error) {
    console.error('Error fetching classes:', error)
  }

  return (
    <UpcomingClassesClient
      classes={classes ?? []}
      profile={profile}
    />
  )
}