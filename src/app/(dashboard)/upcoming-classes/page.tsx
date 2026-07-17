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
        training_id,
        scheduled_at,
        duration_minutes,
        status,
        teams_join_url,
        cancelled_at,
        cancellation_reason,
        cancelled_by,
        rescheduled_by,
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

  // Build a "last time's recap" per student: the most recent PAST lesson that has a
  // written report, plus the study sheets assigned in that lesson. No teacher_id filter —
  // cross-teacher recap is intended so a substitute sees the prior teacher's notes.
  const studentIds = Array.from(
    new Set(
      (rawLessons ?? [])
        .map((l: any) => (Array.isArray(l.students) ? l.students[0] : l.students)?.id)
        .filter((id: string | undefined): id is string => Boolean(id))
    )
  )

  // prevByStudent: student_id -> { lessonId, scheduledAt, feedbackText }
  const prevByStudent = new Map<string, { lessonId: string; scheduledAt: string; feedbackText: string }>()

  if (studentIds.length > 0) {
    const { data: pastLessons } = await adminClient
      .from('lessons')
      .select('id, student_id, scheduled_at, reports ( feedback_text )')
      .in('student_id', studentIds)
      .in('status', ['completed', 'student_no_show', 'teacher_no_show'])
      .lt('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: false })

    // Rows arrive newest-first; the FIRST row per student with non-empty feedback wins.
    for (const pl of (pastLessons ?? []) as any[]) {
      if (prevByStudent.has(pl.student_id)) continue
      const report = Array.isArray(pl.reports) ? pl.reports[0] : pl.reports
      const feedbackText: string | null = report?.feedback_text ?? null
      if (!feedbackText || feedbackText.trim() === '') continue
      prevByStudent.set(pl.student_id, {
        lessonId: pl.id,
        scheduledAt: pl.scheduled_at,
        feedbackText,
      })
    }
  }

  // Fetch the study sheets assigned in each selected previous lesson.
  const prevLessonIds = Array.from(prevByStudent.values()).map((p) => p.lessonId)
  const sheetsByLesson = new Map<string, { id: string; title: string; category: string; level: string }[]>()

  if (prevLessonIds.length > 0) {
    const { data: assignments } = await adminClient
      .from('assignments')
      .select('lesson_id, study_sheet:study_sheets ( id, title, category, level )')
      .in('lesson_id', prevLessonIds)

    for (const a of (assignments ?? []) as any[]) {
      if (!a.lesson_id) continue
      const sheet = Array.isArray(a.study_sheet) ? a.study_sheet[0] : a.study_sheet
      if (!sheet) continue
      const list = sheetsByLesson.get(a.lesson_id) ?? []
      list.push({ id: sheet.id, title: sheet.title, category: sheet.category, level: sheet.level })
      sheetsByLesson.set(a.lesson_id, list)
    }
  }

  const classes = (rawLessons ?? []).map((l: any) => {
    const student = Array.isArray(l.students) ? l.students[0] : l.students
    const scheduledAt = new Date(l.scheduled_at)
    const endsAt = new Date(scheduledAt.getTime() + l.duration_minutes * 60 * 1000)
    const prev = student?.id ? prevByStudent.get(student.id) : undefined
    const prevReport = prev
      ? {
          scheduledAt: prev.scheduledAt,
          feedbackText: prev.feedbackText,
          sheets: sheetsByLesson.get(prev.lessonId) ?? [],
        }
      : null
    return {
      id: l.id,
      training_id: l.training_id,
      starts_at: l.scheduled_at,
      ends_at: endsAt.toISOString(),
      status: l.status,
      teams_link: l.teams_join_url,
      prevReport,
      cancelled_at: l.cancelled_at ?? null,
      cancellation_reason: l.cancellation_reason ?? null,
      cancelled_by: l.cancelled_by ?? null,
      rescheduled_by: l.rescheduled_by ?? null,
      student,
    }
  })

  if (profile && profile.profile_completed !== true) {
    redirect('/account?confirm_tz=1')
  }

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
      teacherTimezone={teacherTimezone ?? 'UTC' /* unreachable: confirmed teachers always have a timezone; redirect guard above catches the empty case */}
    />
  )
}
