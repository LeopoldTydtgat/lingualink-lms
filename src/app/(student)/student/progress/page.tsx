import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ProgressClient from './ProgressClient'

export default async function ProgressPage() {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, timezone')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

  // Get the active training (most recent active, or most recent overall)
  const { data: training } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, start_date, end_date, package_type, status')
    .eq('student_id', student.id)
    .order('start_date', { ascending: false })
    .limit(1)
    .single()

  // Get all completed and student_no_show lessons (these consume hours and appear in history)
  const { data: completedLessons } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, status, teacher_id')
    .eq('student_id', student.id)
    .in('status', ['completed', 'student_no_show'])
    .order('scheduled_at', { ascending: false })

  // Get the most recent report that has level_data (for the radar chart)
  // We join through lessons to find reports for this student
  const { data: reportsWithLevel } = await supabase
    .from('reports')
    .select(`
      id,
      level_data,
      completed_at,
      lessons!inner(student_id)
    `)
    .eq('lessons.student_id', student.id)
    .not('level_data', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(1)

  const latestLevelReport = reportsWithLevel && reportsWithLevel.length > 0
    ? reportsWithLevel[0]
    : null

  // Get total assignments for this student
  const { count: totalAssigned } = await supabase
    .from('assignments')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', student.id)

  // Get completed exercises for this student
  const { count: totalCompleted } = await supabase
    .from('exercise_completions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', student.id)

  return (
    <ProgressClient
      student={student}
      training={training ?? null}
      completedLessons={completedLessons ?? []}
      latestLevelData={latestLevelReport?.level_data ?? null}
      latestLevelDate={latestLevelReport?.completed_at ?? null}
      totalAssigned={totalAssigned ?? 0}
      totalCompleted={totalCompleted ?? 0}
    />
  )
}
