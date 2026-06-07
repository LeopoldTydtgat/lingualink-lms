import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ACTIVE_AND_CANCELLED_STATUSES } from '@/lib/billing/billability'
import { redirect } from 'next/navigation'
import UpcomingClassesClient from './UpcomingClassesClient'

export default async function UpcomingClassesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminClient = createAdminClient()

  const [{ data: profile }, { data: rawLessons, error }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, role, photo_url, timezone, profile_completed, profile_banner_dismissed')
      .eq('id', user.id)
      .maybeSingle(),
    adminClient
      .from('lessons')
      .select(`
        id,
        scheduled_at,
        duration_minutes,
        status,
        teams_join_url,
        cancelled_at,
        cancellation_reason,
        cancelled_by,
        students (
          id,
          full_name,
          photo_url
        )
      `)
      .eq('teacher_id', user.id)
      .in('status', ACTIVE_AND_CANCELLED_STATUSES)
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true }),
  ])

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
      cancelled_at: l.cancelled_at ?? null,
      cancellation_reason: l.cancellation_reason ?? null,
      cancelled_by: l.cancelled_by ?? null,
      student,
    }
  })

  // Fail-SAFE (not fail-closed): teacher's default landing page. A null timezone must
  // NOT throw - that bubbles to app/error.tsx (no (dashboard) boundary) and error-screens
  // the teacher on login. Degrade by logging loudly; class times are not money, and
  // post-S111 a null tz is a near-impossible schema violation.
  const teacherTimezone = profile?.timezone ?? null
  if (!teacherTimezone) {
    console.error('CRITICAL: teacher timezone is null on upcoming-classes landing - class times may display incorrectly', { teacher_id: user.id })
  }

  return (
    <UpcomingClassesClient
      classes={classes}
      profile={profile ?? { id: user.id, full_name: 'Teacher', role: 'teacher', photo_url: null }}
      profileCompleted={profile?.profile_completed ?? false}
      bannerDismissed={profile?.profile_banner_dismissed ?? false}
      teacherTimezone={teacherTimezone ?? 'Europe/London'}
    />
  )
}
