import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import MyClassesClient from './MyClassesClient'
import { requireTz } from '@/lib/time/requireTz'
import { computeStreakWeeks } from '@/lib/lessons/streak'

export default async function MyClassesPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  const { data: student } = await supabase
    .from('students')
    .select('id, timezone, profile_completed, profile_banner_dismissed')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (!student) redirect('/student/login')

  if (student.profile_completed !== true) {
    redirect('/student/account?confirm_tz=1')
  }

  const tz = requireTz(student.timezone, 'my-classes:student')

  // Fetch upcoming scheduled lessons with teacher info. Cancelled lessons are
  // deliberately NOT fetched: the student list no longer renders them, and the rows
  // carry cancellation_reason / cancelled_by that must not ship to the client unused.
  const { data: rawLessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      teams_join_url,
      status,
      cancelled_at,
      cancellation_reason,
      cancelled_by,
      rescheduled_by,
      teacher_id,
      training_id,
      teacher:profiles!teacher_id (
        id,
        full_name,
        photo_url
      )
    `)
    .eq('student_id', student.id)
    .gte('scheduled_at', new Date().toISOString())
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })

  // Supabase returns joins as arrays — flatten to single objects
  const lessons = (rawLessons ?? []).map((lesson) => ({
    ...lesson,
    teacher: Array.isArray(lesson.teacher)
      ? lesson.teacher[0] ?? null
      : lesson.teacher,
  }))

  // Hours/end-date for the empty-state meta line. Mirrors the trainings derivation in
  // src/app/(student)/student/layout.tsx (right panel "Hours Remaining" card) — the two
  // must stay in sync so these numbers can never disagree with the panel. One deliberate
  // difference: a missing training row is passed as null (the layout collapses it to 0)
  // so the client can fall back to the Book-a-Class variant instead of falsely telling
  // the student they are out of hours.
  const { data: training } = await supabase
    .from('trainings')
    .select('total_hours, hours_consumed, end_date')
    .eq('student_id', student.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const hoursRemaining = training
    ? Math.max(0, (training.total_hours ?? 0) - (training.hours_consumed ?? 0))
    : null
  const trainingEndDate = training?.end_date ?? null

  // Completed lessons power the stat cards. hoursCompleted is REAL learning time
  // (sum of durations) — deliberately NOT trainings.hours_consumed, which also folds
  // in booking-time deductions.
  const { data: completedLessons } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('student_id', student.id)
    .eq('status', 'completed')

  const completedRows = completedLessons ?? []
  const completedCount = completedRows.length
  const hoursCompleted =
    completedRows.reduce((sum, l) => sum + (l.duration_minutes ?? 0), 0) / 60

  // Streak: consecutive weeks (Mon–Sun) with >=1 completed lesson, in the student's tz.
  // Shared with the right-panel streak banner via computeStreakWeeks.
  const streakWeeks = computeStreakWeeks(
    completedRows.map((l) => l.scheduled_at),
    tz
  )

  // Find the most recent completed lesson to pull its feedback
  // This becomes the "About This Class" recap on the next class card.
  // This RLS-bound query is the ownership gate for the report read below.
  const { data: lastLesson } = await supabase
    .from('lessons')
    .select('id')
    .eq('student_id', student.id)
    .eq('status', 'completed')
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // public.reports has RLS policies for teachers and admins only - there is no
  // student SELECT policy, and that is deliberate: a student policy would expose
  // the whole row including student_confirmed and impersonation_note (a fraud flag
  // the teacher writes ABOUT the student), and column-level REVOKE cannot separate
  // students from teachers because both share the `authenticated` role.
  // So read the safe column server-side through the service-role client, exactly
  // as (dashboard)/account/page.tsx reads student_reviews. The lesson_id filter is
  // pinned to the lesson the RLS-bound query above already proved belongs to this
  // student - that filter IS the security boundary, because the admin client
  // bypasses RLS. Never widen this select list.
  // reports has a UNIQUE constraint on lesson_id, so maybeSingle() is exact.
  let lastFeedback: string | null = null
  if (lastLesson) {
    const admin = createAdminClient()
    const { data: report, error: reportError } = await admin
      .from('reports')
      .select('feedback_text')
      .eq('lesson_id', lastLesson.id)
      .eq('did_class_happen', true)
      .maybeSingle()

    if (reportError) {
      // Fail soft: the card simply drops the "About This Class" recap.
      console.error('[student/my-classes] report fetch failed:', reportError)
    } else {
      lastFeedback = (report?.feedback_text ?? null) as string | null
    }
  }

  return (
    <MyClassesClient
      lessons={lessons}
      lastFeedback={lastFeedback}
      studentTimezone={tz}
      profileCompleted={student.profile_completed ?? false}
      bannerDismissed={student.profile_banner_dismissed ?? false}
      hoursRemaining={hoursRemaining}
      trainingEndDate={trainingEndDate}
      completedCount={completedCount}
      hoursCompleted={hoursCompleted}
      streakWeeks={streakWeeks}
    />
  )
}
