import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import UpcomingClassesClient from './UpcomingClassesClient'

export default async function UpcomingClassesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // Do NOT redirect to /login if profile is null — the layout already
  // verified authentication. A missing profile is a data issue, not an auth issue.

  const { data: rawClasses, error } = await supabase
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
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })

  if (error) {
    console.error('Error fetching classes:', error)
  }

  const classes = (rawClasses ?? []).map((c: any) => ({
    ...c,
    student: Array.isArray(c.student) ? c.student[0] : c.student,
  }))

  return (
    <UpcomingClassesClient
      classes={classes}
      profile={profile ?? { id: user.id, full_name: 'Teacher', role: 'teacher', photo_url: null }}
    />
  )
}
