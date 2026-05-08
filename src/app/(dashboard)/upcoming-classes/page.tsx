import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import UpcomingClassesClient from './UpcomingClassesClient'

export default async function UpcomingClassesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, photo_url, timezone, profile_completed, profile_banner_dismissed')
    .eq('id', user.id)
    .single()

  // Do NOT redirect to /login if profile is null — the layout already
  // verified authentication. A missing profile is a data issue, not an auth issue.

  const adminClient = createAdminClient()
  const { data: rawLessons, error } = await adminClient
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teams_join_url,
      students (
        id,
        full_name,
        photo_url
      )
    `)
    .eq('teacher_id', user.id)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })

  if (error) {
    console.error('Error fetching lessons:', error)
  }

  const classes = (rawLessons ?? []).map((l: any) => {
    const student = Array.isArray(l.students) ? l.students[0] : l.students
    const scheduledAt = new Date(l.scheduled_at)
    const endsAt = new Date(scheduledAt.getTime() + l.duration_minutes * 60 * 1000)
    return {
      id: l.id,
      starts_at: l.scheduled_at,
      ends_at: endsAt.toISOString(),
      status: l.status,
      teams_link: l.teams_join_url,
      lesson_notes: null,
      student,
    }
  })

  return (
    <UpcomingClassesClient
      classes={classes}
      profile={profile ?? { id: user.id, full_name: 'Teacher', role: 'teacher', photo_url: null }}
      profileCompleted={profile?.profile_completed ?? false}
      bannerDismissed={profile?.profile_banner_dismissed ?? false}
      teacherTimezone={profile?.timezone ?? 'Europe/London'}
    />
  )
}
