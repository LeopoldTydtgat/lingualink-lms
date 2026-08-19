import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import { hasUsableLevelData } from '@/lib/levels/levelData'
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

  // Get the ACTIVE training. status must be filtered in SQL, not left to the
  // ordering: without it this picked the newest row of ANY status, and Postgres
  // sorts NULLs FIRST on DESC, so a historical training with a null start_date
  // outranked the live one. Harmless while every student has exactly one
  // training; wrong the moment a second one exists. At most one row can now
  // match (one_active_training_per_student), so maybeSingle stays correct, and
  // no active training legitimately yields null — ProgressClient already renders
  // the "No active training found" state for it.
  const { data: training } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, start_date, end_date, package_type, status')
    .eq('student_id', student.id)
    .eq('status', 'active')
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

  // Ownership gate for the report read below. Deliberately every lesson of this
  // student regardless of status, matching the previous lessons!inner(student_id)
  // filter: a report can exist on any past lesson, not just the hours-consuming
  // ones fetched above. This RLS-bound query returns ids only.
  const { data: studentLessonIdRows } = await supabase
    .from('lessons')
    .select('id')
    .eq('student_id', student.id)

  const studentLessonIds = (studentLessonIdRows ?? []).map((l) => l.id as string)

  // Pick the level assessment that drives the overall level shown to the student.
  //
  // public.reports has RLS policies for teachers and admins only - there is no
  // student SELECT policy, and that is deliberate: a student policy would expose
  // the whole row including student_confirmed and impersonation_note (a fraud flag
  // the teacher writes ABOUT the student), and column-level REVOKE cannot separate
  // students from teachers because both share the `authenticated` role.
  // So read the safe columns server-side through the service-role client, exactly
  // as (dashboard)/account/page.tsx reads student_reviews. The .in() filter is
  // restricted to lesson ids the RLS-bound query above already proved belong to
  // this student - that filter IS the security boundary, because the admin client
  // bypasses RLS. Never widen this select list.
  // Only submitted reports (non-null completed_at) drive the level display -
  // a report reopened by admin for correction is excluded until re-filed, and
  // this also prevents Postgres NULLS-FIRST DESC ordering from promoting a
  // reopened report to the top.
  //
  // There is deliberately NO .not('level_data','is',null) filter any more. It
  // excluded SQL NULL only, while complete_report_atomic writes
  // `level_data = p_report_payload->'level_data'` - which stores jsonb null for
  // a no-show and {} for a class where the teacher graded no skill. Neither is
  // SQL NULL, so both passed the filter, and .limit(1) then made one of them
  // "the latest assessment": the chart fell back to its empty state while that
  // row's completed_at still printed the date line above it. Confirmed against
  // live data. So fetch a bounded newest-first window instead and let
  // hasUsableLevelData - the same predicate the charts gate on - choose the row.
  let latestLevelReport: {
    level_data: Record<string, string> | null
    completed_at: string | null
  } | null = null

  if (studentLessonIds.length > 0) {
    const admin = createAdminClient()
    const { data: recentReports, error: reportsError } = await admin
      .from('reports')
      .select('level_data, completed_at')
      .in('lesson_id', studentLessonIds)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(20)

    if (reportsError) {
      // Fail soft: the page still renders, the level assessment just shows its
      // "no assessment yet" state instead of 500-ing the whole progress view.
      console.error('[student/progress] reports fetch failed:', reportsError)
    } else {
      // Newest-first, so the first qualifying row IS the latest real assessment.
      // Both values below come from that ONE row, so the date line can never
      // describe a different report than the chart. Nothing qualifying in the
      // window leaves this null, and the client then renders its empty state
      // with no date line above it.
      const chosen = (recentReports ?? []).find((row) => hasUsableLevelData(row.level_data))
      if (chosen) {
        latestLevelReport = {
          level_data: (chosen.level_data ?? null) as Record<string, string> | null,
          completed_at: (chosen.completed_at ?? null) as string | null,
        }
      }
    }
  }

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
