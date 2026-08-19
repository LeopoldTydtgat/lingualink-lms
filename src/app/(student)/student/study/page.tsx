import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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

  // --- Teaching-material homework grants -----------------------------------
  // USER-SCOPED read: the material_assignments SELECT policy is the gate, exactly
  // as in /student/study/material/[assignmentId] and /api/material-assignment-file.
  // `revoked_at is null` is already encoded in the student policy; it is repeated
  // here only as the list filter this page needs, never as a re-derived gate.
  //
  // Explicit column list, never select('*'): material_assignments carries a
  // column-level UPDATE grant (annotations, updated_at only).
  //
  // A query error is NOT an empty grant list, but this is one block on a page
  // that must still render its assignments and practice library, so the failure
  // is logged and the material list falls back to empty rather than crashing.
  const { data: materialRaw, error: materialError } = await supabase
    .from('material_assignments')
    .select('id, study_sheet_id, attachment_name, page_start, page_end, assigned_at')
    .eq('student_id', student.id)
    .is('revoked_at', null)
    .order('assigned_at', { ascending: false })

  if (materialError) {
    console.error('[student/study] material_assignments lookup failed:', materialError)
  }

  const materialRows = materialError ? [] : (materialRaw ?? [])

  // Material grants are always issued against audience='staff' sheets
  // (api/teacher/material-assignments/route.ts), and the student SELECT policy on
  // study_sheets requires audience='student' - so a user-scoped read returns
  // NOTHING and there would be no title to show. Read TITLES ONLY on the
  // service-role client, mirroring /student/study/material/[assignmentId].
  //
  // DISPLAY-ONLY, never an access gate: authorisation was settled by the
  // RLS-bound read above, and the bytes are gated again, independently, by
  // /api/material-assignment-file. This is a Server Component, so nothing
  // service-role reaches the client bundle - only the plain title strings do.
  //
  // Fail soft: a failed lookup or a missing sheet falls back to the granted
  // filename, matching /student/study/material/[assignmentId]. Never a generic
  // label - the internal staff taxonomy must not surface on a student screen.
  const materialSheetIds = [
    ...new Set(materialRows.map((m) => m.study_sheet_id as string)),
  ]

  const materialTitles = new Map<string, string>()
  if (materialSheetIds.length > 0) {
    const adminClient = createAdminClient()
    const { data: materialSheetRows, error: materialSheetError } = await adminClient
      .from('study_sheets')
      .select('id, title')
      .in('id', materialSheetIds)

    if (materialSheetError) {
      console.error('[student/study] study_sheets title lookup failed:', materialSheetError)
    }

    for (const row of materialSheetRows ?? []) {
      if (typeof row.title === 'string' && row.title.length > 0) {
        materialTitles.set(row.id as string, row.title)
      }
    }
  }

  const materialAssignments = materialRows.map((m) => ({
    id: m.id as string,
    title: materialTitles.get(m.study_sheet_id as string) ?? (m.attachment_name as string),
    attachment_name: m.attachment_name as string,
    page_start: m.page_start as number | null,
    page_end: m.page_end as number | null,
    assigned_at: m.assigned_at as string,
  }))

  // Fetch all active study sheets for the "Practice on Your Own" library
  const { data: libraryRaw } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active')
    .eq('is_active', true)
    .eq('audience', 'student')
    .order('title', { ascending: true })

  const assignmentsList = assignmentsRaw ?? []
  const libraryRows = libraryRaw ?? []

  // --- Topic tags for the practice library ---------------------------------
  // Display + filter metadata only, never an access gate. Both reads are
  // USER-SCOPED (never createAdminClient): `authenticated` may SELECT tags
  // freely, and a sheet_tags row is visible exactly when its sheet is visible
  // to the caller - so this can only surface links for sheets already returned
  // by the RLS-bound library read above.
  //
  // Explicit column lists, never select('*').
  //
  // ONLY kind='topic' tags belong on this surface: skill tags duplicate the
  // category column, so any tag_id that does not resolve to a topic tag is
  // dropped rather than leaking through as a chip or a filter option.
  //
  // A query error is NOT "this sheet has no tags", but tags are metadata on a
  // page that must still render its assignments and library, so a failure is
  // logged and falls back to empty - same posture as the material_assignments
  // block above.
  const sheetTopicTags: Record<string, string[]> = {}
  if (libraryRows.length > 0) {
    const { data: sheetTagRaw, error: sheetTagError } = await supabase
      .from('sheet_tags')
      .select('sheet_id, tag_id')
      .in('sheet_id', libraryRows.map((s) => s.id as string))

    if (sheetTagError) {
      console.error('[student/study] sheet_tags lookup failed:', sheetTagError)
    }

    const { data: topicTagRaw, error: topicTagError } = await supabase
      .from('tags')
      .select('id, name')
      .eq('kind', 'topic')

    if (topicTagError) {
      console.error('[student/study] topic tags lookup failed:', topicTagError)
    }

    const sheetTagRows = sheetTagError ? [] : (sheetTagRaw ?? [])
    const topicTagRows = topicTagError ? [] : (topicTagRaw ?? [])

    // Resolving through this map is what enforces kind='topic': a skill tag has
    // no entry here, so its link is skipped.
    const topicTagNames = new Map<string, string>()
    for (const t of topicTagRows) {
      topicTagNames.set(t.id as string, t.name as string)
    }

    for (const link of sheetTagRows) {
      const name = topicTagNames.get(link.tag_id as string)
      if (!name) continue
      const sheetId = link.sheet_id as string
      const names = sheetTopicTags[sheetId] ?? []
      names.push(name)
      sheetTopicTags[sheetId] = names
    }

    // Alphabetical, so the chips and the dropdown render in a stable order.
    for (const names of Object.values(sheetTopicTags)) {
      names.sort()
    }
  }

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

  // Ordered ASCENDING on created_at: the assignmentScores derivation below keeps
  // the LAST matching row it sees, so that row must be the NEWEST attempt. A
  // student who retries at 90% after 50% must see 90.
  //
  // score/created_at are extra columns for that derivation only - the completion
  // rule is unchanged: buildAssignmentCompletion's AttemptActivityRow type is
  // structural, so the extra fields are accepted and ignored.
  const { data: attemptsRaw } = await supabase
    .from('activity_attempts')
    .select('activity_id, assignment_id, score, created_at')
    .eq('student_id', student.id)
    .order('created_at', { ascending: true })
  const attemptRows = (attemptsRaw ?? []) as {
    activity_id: string
    assignment_id: string | null
    score: number | null
    created_at: string
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

  // SCORE RULE: a completed assignment card shows a percentage ONLY where that
  // number is unambiguous - the sheet has EXACTLY ONE activity, and the latest
  // attempt for that activity under that assignment carries a numeric score.
  //
  // Deliberately NO average or any other aggregate across several activities:
  // which number to show for a multi-activity sheet is a business decision that
  // has not been made. More than one activity, zero activities, a writing task
  // (score null), and a marked_done_at assignment with no attempt at all ALL get
  // no entry - never a 0, never a placeholder. Those cards keep the plain
  // "Completed" label.
  //
  // attemptRows is ascending on created_at, so the last match wins = newest.
  const completedAssignmentIdSet = new Set(completedAssignmentIds)
  const assignmentScores: Record<string, number> = {}
  for (const a of assignmentsList) {
    const assignmentId = a.id as string
    if (!completedAssignmentIdSet.has(assignmentId)) continue

    const acts = activityIdsBySheet.get(a.study_sheet_id as string)
    if (!acts || acts.length !== 1) continue
    const activityId = acts[0]

    // Stays null when no attempt row matches, so "no attempt at all" and
    // "attempt with a null score" both fall through to no entry.
    let latest: { score: number | null } | null = null
    for (const t of attemptRows) {
      if (t.assignment_id === assignmentId && t.activity_id === activityId) {
        latest = t
      }
    }

    if (latest && typeof latest.score === 'number') {
      assignmentScores[assignmentId] = latest.score
    }
  }

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
      assignmentScores={assignmentScores}
      practicedSheetIds={practicedSheetIds}
      library={library}
      materialAssignments={materialAssignments}
      sheetTopicTags={sheetTopicTags}
    />
  )
}
