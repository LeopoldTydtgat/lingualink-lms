import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isValidTimeZone } from '@/lib/utils/timezone'
import ReportsClient from './ReportsClient'

export default async function ReportsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, timezone, profile_completed')
    .eq('id', user.id)
    .maybeSingle()

  // A null profile is NOT an unauthenticated user, so this never bounces to
  // /login. Same inline fallback the schedule page renders.
  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  // Confirmed-timezone gate, replicated from (dashboard)/schedule/page.tsx and
  // (dashboard)/upcoming-classes/page.tsx. Class times below are rendered in
  // this viewer's own zone, so an unconfirmed profile is sent to confirm it
  // first. There is deliberately no 'UTC' fallback: silently formatting in UTC
  // prints the wrong wall-clock time for every teacher outside it.
  if (profile.profile_completed !== true) {
    redirect('/account?confirm_tz=1')
  }

  // profile_completed is the confirmation FLAG, not the value it confirms: a row
  // flagged complete but carrying a null timezone still leaves nothing to format
  // in, so it goes back through the same flow rather than to a fallback zone.
  // isValidTimeZone screens the string itself as well, since nothing on the write
  // path checks it is a real IANA id — /api/profile stores the value verbatim.
  // Intl.DateTimeFormat THROWS RangeError on a bad zone, and this route group has
  // no error boundary, so an unscreened value would blank the page instead of
  // prompting for the one thing that fixes it.
  const viewerTimezone = profile.timezone
  if (!viewerTimezone || !isValidTimeZone(viewerTimezone)) {
    redirect('/account?confirm_tz=1')
  }

  const isAdmin = profile?.role === 'admin'

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

  // Teacher portal always scopes to the signed-in teacher's own reports; admin oversight of all reports lives at /admin/reports.
  query.eq('teacher_id', user.id)

  const { data: rawReports, error } = await query

  if (error) {
    console.error('Error fetching reports:', error)
  }

  // Supabase returns nested joins as arrays — flatten them into single objects
  const reports = (rawReports ?? []).map((r: any) => {
    const lesson = Array.isArray(r.lesson) ? r.lesson[0] : r.lesson
    const teacher = lesson && Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson?.teacher
    const student = lesson && Array.isArray(lesson.student) ? lesson.student[0] : lesson?.student
    return {
      ...r,
      lesson: lesson ? { ...lesson, teacher, student } : null,
    }
  })

  return (
    <ReportsClient
      reports={reports}
      profile={profile ?? { id: '', full_name: '', role: '' }}
      isAdmin={isAdmin}
      viewerTimezone={viewerTimezone}
    />
  )
}
