import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import StudyClient from './StudyClient'

export default async function StudyPage() {
  const supabase = await createClient()

  // Get the logged-in user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

  // Fetch all assignments for this student, joined with study sheet details
  const { data: assignmentsRaw } = await supabase
    .from('assignments')
    .select(`
      id,
      lesson_id,
      assigned_at,
      study_sheet_id,
      marked_done_at,
      study_sheets (
        id,
        title,
        category,
        level,
        difficulty,
        is_active
      )
    `)
    .eq('student_id', student.id)
    .order('assigned_at', { ascending: false })

  // Fetch all active study sheets for the "Practice on Your Own" library
  const { data: libraryRaw } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active')
    .eq('is_active', true)
    .eq('audience', 'student')
    .order('title', { ascending: true })

  const assignmentsList = assignmentsRaw ?? []
  const libraryRows = libraryRaw ?? []

  // NEW345 completion + practice state, single-sourced through the helper.
  // Activities must cover BOTH assigned sheets AND library sheets (practice badges).
  const allSheetIds = [
    ...new Set([
      ...assignmentsList.map((a) => a.study_sheet_id as string),
      ...libraryRows.map((s) => s.id as string),
    ]),
  ]

  let activityRows: { id: string; sheet_id: string }[] = []
  if (allSheetIds.length > 0) {
    const { data } = await supabase
      .from('activities')
      .select('id, sheet_id')
      .in('sheet_id', allSheetIds)
    activityRows = (data ?? []) as { id: string; sheet_id: string }[]
  }

  const { data: attemptsRaw } = await supabase
    .from('activity_attempts')
    .select('activity_id, assignment_id')
    .eq('student_id', student.id)
  const attemptRows = (attemptsRaw ?? []) as {
    activity_id: string
    assignment_id: string | null
  }[]

  const markedDoneAssignmentIds = new Set(
    assignmentsList.filter((a) => a.marked_done_at).map((a) => a.id as string)
  )
  const { isComplete, activityIdsBySheet } = buildAssignmentCompletion(
    activityRows,
    markedDoneAssignmentIds,
    attemptRows,
  )

  const completedAssignmentIds = assignmentsList
    .filter((a) => isComplete(a.id as string, a.study_sheet_id as string))
    .map((a) => a.id as string)

  // PRACTICE RULE: a sheet is practiced when it has >= 1 activity and every one
  // of its activities has at least one attempt with assignment_id === null.
  // Zero-activity sheets are never practiced.
  const selfPracticedActivityIds = new Set(
    attemptRows.filter((t) => t.assignment_id === null).map((t) => t.activity_id)
  )
  const practicedSheetIds = allSheetIds.filter((sheetId) => {
    const acts = activityIdsBySheet.get(sheetId)
    return !!acts && acts.length > 0 && acts.every((id) => selfPracticedActivityIds.has(id))
  })

  // Flatten Supabase nested joins (they return arrays, not single objects)
  const assignments = assignmentsList.map((a) => ({
    id: a.id as string,
    lesson_id: a.lesson_id as string,
    assigned_at: a.assigned_at as string,
    study_sheet: Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets,
  }))

  const library = libraryRows

  return (
    <StudyClient
      studentId={student.id}
      assignments={assignments}
      completedAssignmentIds={completedAssignmentIds}
      practicedSheetIds={practicedSheetIds}
      library={library}
    />
  )
}
