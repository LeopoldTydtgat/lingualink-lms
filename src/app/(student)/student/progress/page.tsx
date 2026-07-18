import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import ProgressClient from './ProgressClient'

export default async function ProgressPage() {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, timezone, profile_completed')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (!student) redirect('/student/login')

  if (student.profile_completed !== true) {
    redirect('/student/account?confirm_tz=1')
  }

  // Get the active training (most recent active, or most recent overall)
  const { data: training } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, start_date, end_date, package_type, status')
    .eq('student_id', student.id)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get all completed and student_no_show lessons (these consume hours and appear in history)
  const { data: completedLessons } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, status, teacher_id')
    .eq('student_id', student.id)
    // Hours-consumed set: lessons that drew down the student's balance (completed + student_no_show only). Intentionally inline and distinct from STUDENT_PAST_LESSON_STATUSES — this is a billing-semantics set; see billability.ts.
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

  // Assignments with sheet activity/attempt state so Progress counts match the
  // layout's visible-assignment rule (NEW345 bimodal completion, single-sourced).
  // Deliberate small behaviour change: totals count VISIBLE assignments (active
  // sheet OR complete), not every assignment row.
  const { data: progressAssignmentRows } = await supabase
    .from('assignments')
    .select('id, study_sheet_id, marked_done_at, study_sheets ( is_active )')
    .eq('student_id', student.id)

  const progressAssignments = progressAssignmentRows ?? []
  const progressSheetIds = [
    ...new Set(progressAssignments.map((a) => a.study_sheet_id as string)),
  ]

  let progressActivityRows: { id: string; sheet_id: string }[] = []
  if (progressSheetIds.length > 0) {
    const { data } = await supabase
      .from('activities')
      .select('id, sheet_id')
      .in('sheet_id', progressSheetIds)
    progressActivityRows = (data ?? []) as { id: string; sheet_id: string }[]
  }

  const { data: progressAttemptsRaw } = await supabase
    .from('activity_attempts')
    .select('activity_id, assignment_id')
    .eq('student_id', student.id)
  const progressAttemptRows = (progressAttemptsRaw ?? []) as {
    activity_id: string
    assignment_id: string | null
  }[]

  const progressMarkedDone = new Set(
    progressAssignments.filter((a) => a.marked_done_at).map((a) => a.id as string)
  )
  const { isComplete: isAssignmentComplete } = buildAssignmentCompletion(
    progressActivityRows,
    progressMarkedDone,
    progressAttemptRows,
  )

  const visibleProgressAssignments = progressAssignments.filter((a) => {
    const sheet = Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets
    const completed = isAssignmentComplete(a.id as string, a.study_sheet_id as string)
    return ((sheet as { is_active?: boolean } | null)?.is_active ?? false) || completed
  })

  const totalAssigned = visibleProgressAssignments.length
  const totalCompleted = visibleProgressAssignments.filter((a) =>
    isAssignmentComplete(a.id as string, a.study_sheet_id as string)
  ).length

  return (
    <ProgressClient
      student={student}
      training={training ?? null}
      completedLessons={completedLessons ?? []}
      latestLevelData={latestLevelReport?.level_data ?? null}
      latestLevelDate={latestLevelReport?.completed_at ?? null}
      totalAssigned={totalAssigned}
      totalCompleted={totalCompleted}
    />
  )
}
