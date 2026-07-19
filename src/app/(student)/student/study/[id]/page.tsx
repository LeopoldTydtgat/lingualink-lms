import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { z } from 'zod'
import StudySheetClient, { type ActivitySummary } from './StudySheetClient'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ assignment?: string }>
}

interface AttemptRow {
  activity_id: string
  assignment_id: string | null
  score: number | null
  needs_review: boolean
  created_at: string
}

export default async function StudySheetPage({ params, searchParams }: Props) {
  const { id } = await params
  const { assignment } = await searchParams

  // A malformed assignment param must not kill access to a valid sheet -
  // treat anything that is not a uuid as absent, same as the activity player.
  let assignmentId =
    assignment && z.string().uuid().safeParse(assignment).success ? assignment : null

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

  // Fetch the study sheet
  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, content, attachments')
    .eq('id', id)
    .eq('is_active', true)
    .eq('audience', 'student')
    .single()

  if (!sheet) notFound()

  // Resolve the assignment context. Students have a SELECT policy on their own
  // assignments rows; a miss (stale or foreign link) must not break the page -
  // fall back to practice context instead.
  let assignmentMarkedDone = false
  if (assignmentId) {
    const { data: assignmentRow } = await supabase
      .from('assignments')
      .select('id, marked_done_at')
      .eq('id', assignmentId)
      .eq('student_id', student.id)
      .eq('study_sheet_id', sheet.id)
      .maybeSingle()

    if (assignmentRow) {
      assignmentMarkedDone = assignmentRow.marked_done_at !== null
    } else {
      assignmentId = null
    }
  }

  // Activities for this sheet. RLS scopes visibility; the authenticated column
  // grant on activities excludes answer_key - never select it (or content) here.
  const { data: activitiesRaw } = await supabase
    .from('activities')
    .select('id, position, type, title')
    .eq('sheet_id', id)
    .order('position', { ascending: true })

  const activityRows = activitiesRaw ?? []

  // This student's attempts across the sheet's activities. Ordered ascending so
  // the last write into the map below is the newest attempt per activity.
  let attemptRows: AttemptRow[] = []
  if (activityRows.length > 0) {
    const { data: attemptsRaw } = await supabase
      .from('activity_attempts')
      .select('activity_id, assignment_id, score, needs_review, created_at')
      .eq('student_id', student.id)
      .in('activity_id', activityRows.map((a) => a.id))
      .order('created_at', { ascending: true })

    attemptRows = attemptsRaw ?? []
  }

  // Context scoping mirrors the old alreadyCompleted rule: an assignment
  // context counts only attempts made under that assignment; practice context
  // counts only attempts with no assignment.
  const latestByActivity = new Map<string, AttemptRow>()
  for (const row of attemptRows) {
    const inContext = assignmentId
      ? row.assignment_id === assignmentId
      : row.assignment_id === null
    if (inContext) latestByActivity.set(row.activity_id, row)
  }

  const activities: ActivitySummary[] = activityRows.map((a) => {
    const latest = latestByActivity.get(a.id)
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      status: !latest ? 'not_started' : latest.needs_review ? 'pending_review' : 'done',
      score: latest?.score ?? null,
    }
  })

  return (
    <StudySheetClient
      sheet={sheet}
      activities={activities}
      assignmentId={assignmentId}
      assignmentMarkedDone={assignmentMarkedDone}
    />
  )
}
