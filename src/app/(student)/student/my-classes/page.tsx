import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ACTIVE_AND_CANCELLED_STATUSES } from '@/lib/billing/billability'
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

  // Fetch upcoming lessons (scheduled + cancelled) with teacher info
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
    .in('status', ACTIVE_AND_CANCELLED_STATUSES)
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
  // This becomes the "About This Class" recap on the next class card
  const { data: lastLesson } = await supabase
    .from('lessons')
    .select('id')
    .eq('student_id', student.id)
    .eq('status', 'completed')
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let lastFeedback: string | null = null
  if (lastLesson) {
    const { data: report } = await supabase
      .from('reports')
      .select('feedback_text')
      .eq('lesson_id', lastLesson.id)
      .eq('did_class_happen', true)
      .maybeSingle()
    lastFeedback = report?.feedback_text ?? null
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
