import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ACTIVE_AND_CANCELLED_STATUSES } from '@/lib/billing/billability'
import { MAX_LESSON_MS } from '@/app/api/student/availability/slotEngine'
import { redirect } from 'next/navigation'
import UpcomingClassesClient from './UpcomingClassesClient'

export default async function UpcomingClassesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminClient = createAdminClient()

  // One request-time instant shared by the query bound and the end-based filter below,
  // so the two can never disagree about "now". new Date().getTime() rather than
  // Date.now(): the react-hooks/purity rule mis-fires on Date.now() in async Server
  // Components, and the repo's only other remedy is a file-wide rule disable.
  const listNowMs = new Date().getTime()

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
      // COARSE prefilter only, widened by the longest bookable lesson so a class that
      // has already started is still fetched. Instant-vs-instant (UTC): scheduled_at is
      // a timestamptz and this bound is an instant, NOT a local calendar date — the
      // toISOString() ban covers local date CONSTRUCTION, which this is not.
      // The exact "has it ended" test is the end-based filter below.
      .gte('scheduled_at', new Date(listNowMs - MAX_LESSON_MS).toISOString())
      .order('scheduled_at', { ascending: true }),
  ])

  if (error) {
    console.error('Error fetching lessons:', error)
  }

  // A class leaves this list when it ENDS, not when it starts - every status, scheduled
  // and cancelled alike. For scheduled rows this keeps an in-progress class on screen,
  // matching the right panel's "In class" state ((dashboard)/layout.tsx picks its lesson
  // with the same now < start + duration rule).
  //
  // Cancelled rows previously used a start-based cutoff on the reasoning that a cancelled
  // class has nothing left to run. That reasoning was wrong for this surface: a student
  // cancelling inside 24 hours produced a row that lived less than 24 hours, so a teacher
  // not logged in during that window never saw the cancellation at all - the exact
  // complaint the cancelled cards were built to answer. Client rule, 21 Aug: a cancelled
  // class stays visible for the whole slot it would have occupied, then goes.
  //
  // The permanent record lives on the teacher Past Classes page (not yet built). That page
  // MUST use this same end-based cutoff, or a cancelled class falls into a gap where it is
  // on neither list for the length of its slot.
  //
  // NOTE: (dashboard)/students/[id]/page.tsx deliberately keeps the old two-branch rule.
  // There the same predicate also feeds the Next Classes tab, so a cancelled row lingering
  // past its start would appear under a heading that promises classes that will happen.
  // The two files are meant to differ; do not "align" them.
  //
  // The coarse SQL prefilter above already reaches back MAX_LESSON_MS to catch in-progress
  // classes, so cancelled rows mid-slot are fetched without any query change.
  const visibleLessons = (rawLessons ?? []).filter((l) => {
    const startMs = new Date(l.scheduled_at).getTime()
    return listNowMs < startMs + l.duration_minutes * 60 * 1000
  })

  // Build a "last time's recap" per student: the most recent PAST lesson that has a
  // written report, plus the study sheets assigned in that lesson. No teacher_id filter —
  // cross-teacher recap is intended so a substitute sees the prior teacher's notes.
  const studentIds = Array.from(
    new Set(
      visibleLessons
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

  const classes = visibleLessons.map((l: any) => {
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
