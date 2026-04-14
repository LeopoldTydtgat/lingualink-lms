import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import MyClassesClient from './MyClassesClient'

export default async function MyClassesPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  const { data: student } = await supabase
    .from('students')
    .select('id, timezone, profile_completed')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

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
    .in('status', ['scheduled', 'cancelled'])
    .order('scheduled_at', { ascending: true })

  // Supabase returns joins as arrays — flatten to single objects
  const lessons = (rawLessons ?? []).map((lesson) => ({
    ...lesson,
    teacher: Array.isArray(lesson.teacher)
      ? lesson.teacher[0] ?? null
      : lesson.teacher,
  }))

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
      studentTimezone={student.timezone ?? 'Europe/London'}
      profileCompleted={student.profile_completed ?? true}
    />
  )
}