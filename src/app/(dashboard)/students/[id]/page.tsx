import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import StudentDetailClient from './StudentDetailClient'

type RawSheetJoin = { title: string; category: string; level: string } | null

type RawAssignmentRow = {
  id: string
  assigned_at: string
  study_sheet_id: string
  marked_done_at: string | null
  study_sheets: RawSheetJoin | RawSheetJoin[]
}

// One live teaching-material homework grant (material_assignments row), as read
// for the read-only Homework section. `annotations` is jsonb, so nothing about
// its shape is guaranteed at runtime: it is narrowed to a boolean server-side and
// the array itself never reaches the client.
type RawMaterialAssignmentRow = {
  id: string
  study_sheet_id: string
  attachment_name: string
  page_start: number | null
  page_end: number | null
  annotations: unknown
  assigned_at: string
}

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const isAdmin = profile?.role === 'admin'

  // Viewer's own zone for instant labels in the client (da9067b convention: profiles
  // timezone with a display-only UTC fallback - this is a maybeSingle'd profile, not
  // the fail-closed student-portal path).
  const viewerTz = profile?.timezone ?? 'UTC'

  // Fetch the training with student info
  const adminClient = createAdminClient()
  const { data: training, error } = await adminClient
    .from('trainings')
    .select(`
      id,
      status,
      total_hours,
      hours_consumed,
      start_date,
      end_date,
      package_type,
      notes,
      teacher_id,
      students (
        id,
        full_name,
        photo_url,
        timezone,
        learning_goals,
        interests,
        language_preference,
        teacher_notes
      ),
      training_teachers (
        teacher_id,
        profiles (
          id,
          full_name
        )
      )
    `)
    .eq('id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !training) notFound()

  // Assigned teachers come from the training_teachers list (regular teacher plus any substitutes).
  // Flatten the nested join: each row has teacher_id, and profiles may arrive as object or array.
  type TeacherJoinRow = { teacher_id: string; profiles: { id: string; full_name: string } | { id: string; full_name: string }[] | null }
  const teacherRows = (Array.isArray(training.training_teachers) ? training.training_teachers : []) as TeacherJoinRow[]
  const assignedTeacherNames = teacherRows
    .map(r => (Array.isArray(r.profiles) ? r.profiles[0]?.full_name : r.profiles?.full_name))
    .filter((n): n is string => Boolean(n))

  // Non-admin access gate (Condition B only), mirroring the students list page so a card shown
  // there always opens here. Access requires an active booked-class relationship with THIS
  // training: an upcoming scheduled lesson, or an open report (pending in-window, or reopened
  // until completed) on a lesson this teacher personally holds. Formal training_teachers
  // assignment alone no longer grants access. Falls closed: no claim -> notFound().
  if (!isAdmin) {
    const gateNow = new Date()
    const { data: gateLessonsRaw } = await adminClient
      .from('lessons')
      .select('id, scheduled_at, status')
      .eq('training_id', id)
      .eq('teacher_id', user.id)

    type GateLessonRow = { id: string; scheduled_at: string | null; status: string }
    const gateLessons = (gateLessonsRaw ?? []) as GateLessonRow[]

    // B1: an upcoming scheduled lesson on this training held by this teacher.
    let hasActiveClaim = gateLessons.some(
      l => l.status === 'scheduled' && l.scheduled_at && new Date(l.scheduled_at) > gateNow
    )

    // B2: an open (pending/reopened) report on one of this teacher's lessons for this training.
    if (!hasActiveClaim && gateLessons.length > 0) {
      const gateLessonIds = gateLessons.map(l => l.id)
      const { data: gateReportsRaw } = await adminClient
        .from('reports')
        .select('status, deadline_at')
        .in('lesson_id', gateLessonIds)
        .in('status', ['pending', 'reopened'])

      // 'pending' counts only inside its window; 'reopened' counts until completed (stale deadline).
      type GateReportRow = { status: string; deadline_at: string | null }
      hasActiveClaim = ((gateReportsRaw ?? []) as GateReportRow[]).some(
        r => r.status === 'reopened' || (r.deadline_at && new Date(r.deadline_at) > gateNow)
      )
    }

    if (!hasActiveClaim) notFound()
  }

  // Fetch all lessons for this training
  const { data: lessons } = await adminClient
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teams_join_url,
      teacher_id,
      cancelled_at,
      cancellation_reason,
      cancelled_by,
      rescheduled_by,
      profiles!lessons_teacher_id_fkey (
        full_name
      )
    `)
    .eq('training_id', id)
    .order('scheduled_at', { ascending: true })

  // Fetch completed reports for this training's lessons
  const lessonIds = lessons?.map(l => l.id) ?? []

  const { data: reports } = lessonIds.length > 0
    ? await adminClient
        .from('reports')
        .select(`
          id,
          lesson_id,
          did_class_happen,
          no_show_type,
          feedback_text,
          level_data,
          status,
          completed_at
        `)
        .in('lesson_id', lessonIds)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
    : { data: [] }

  // Fetch assignments for this student
  const studentRecord = Array.isArray(training.students)
    ? training.students[0]
    : training.students
  const studentId = (studentRecord as { id: string } | null)?.id

  // --- Teaching-material homework grants (read-only Homework section) -------
  // USER-SCOPED read, deliberately NOT adminClient: the material_assignments
  // SELECT policy ("Teachers read material assignments for own students", via
  // trainings / get_teacher_training_ids()) IS the gate on this list. Service role
  // bypasses RLS and would leave this list with no relationship check at all.
  //
  // Explicit column list, never select('*'): material_assignments carries a
  // column-level UPDATE grant (annotations, updated_at only). Revoked grants stay
  // in the table as history and are filtered out here - the teacher view shows
  // live grants only, and the viewer sub-route re-applies the same filter so a
  // direct URL cannot reach a revoked one either.
  //
  // The error is BOUND and surfaced to the client as its own state: a failed
  // lookup must never render as "this student has no homework".
  const { data: materialRaw, error: materialError } = studentId
    ? await supabase
        .from('material_assignments')
        .select('id, study_sheet_id, attachment_name, page_start, page_end, annotations, assigned_at')
        .eq('student_id', studentId)
        .is('revoked_at', null)
        .order('assigned_at', { ascending: false })
    : { data: [], error: null }

  if (materialError) {
    console.error(`[dashboard/students/[id]] material_assignments lookup failed (training ${id}):`, materialError)
  }

  const materialRows = (materialError ? [] : (materialRaw ?? [])) as RawMaterialAssignmentRow[]

  // Display titles, USER-SCOPED on purpose. The student-portal pages read these on
  // the service-role client because the student RLS tier cannot see staff-audience
  // sheets at all; a teacher's tier CAN see them, minus another teacher's private
  // (owner_id-scoped) material. Reading titles service-role here would therefore
  // hand this teacher the titles of sheets their own tier denies them. Where RLS
  // denies the sheet the row falls back to the granted filename instead.
  const materialSheetIds = [...new Set(materialRows.map(m => m.study_sheet_id))]
  const materialTitles = new Map<string, string>()

  if (materialSheetIds.length > 0) {
    const { data: materialSheetRows, error: materialSheetError } = await supabase
      .from('study_sheets')
      .select('id, title')
      .in('id', materialSheetIds)

    if (materialSheetError) {
      console.error(`[dashboard/students/[id]] study_sheets title lookup failed (training ${id}):`, materialSheetError)
    }

    for (const row of ((materialSheetRows ?? []) as { id: string; title: string | null }[])) {
      if (typeof row.title === 'string' && row.title.length > 0) {
        materialTitles.set(row.id, row.title)
      }
    }
  }

  // hasWork is derived HERE, server-side: the annotations array is the student's
  // actual work and can be large, so only the boolean crosses into the client
  // bundle. The full layer is read once, by the viewer sub-route, for the single
  // grant being opened.
  const materialAssignments = materialRows.map(m => ({
    id: m.id,
    title: materialTitles.get(m.study_sheet_id) ?? m.attachment_name,
    page_start: m.page_start,
    page_end: m.page_end,
    assigned_at: m.assigned_at,
    hasWork: Array.isArray(m.annotations) && m.annotations.length > 0,
  }))

  const { data: rawAssignments } = studentId
    ? await adminClient
        .from('assignments')
        .select('id, assigned_at, study_sheet_id, marked_done_at, study_sheets(title, category, level)')
        .eq('student_id', studentId)
        .order('assigned_at', { ascending: false })
    : { data: [] }

  const assignmentRows = (rawAssignments ?? []) as RawAssignmentRow[]

  // Per-assignment completion via the NEW345 bimodal rule (see lib/study/assignmentCompletion):
  // an assignment is complete when its marked_done_at is set, OR the sheet has
  // activities and every one has an attempt under that assignment.
  const assignmentIds = assignmentRows.map(a => a.id)
  const sheetIds = [...new Set(assignmentRows.map(a => a.study_sheet_id))]

  type ActivityRow = { id: string; sheet_id: string }
  type AttemptRow = { activity_id: string; assignment_id: string | null; created_at: string }

  // activities has NO is_active column (verified: 20260715120000 migration).
  let activityRows: ActivityRow[] = []
  if (sheetIds.length > 0) {
    const { data } = await adminClient
      .from('activities')
      .select('id, sheet_id')
      .in('sheet_id', sheetIds)
    activityRows = (data ?? []) as ActivityRow[]
  }

  let attemptRows: AttemptRow[] = []
  if (assignmentIds.length > 0) {
    const { data: atts } = await adminClient
      .from('activity_attempts')
      .select('activity_id, assignment_id, created_at')
      .in('assignment_id', assignmentIds)
    attemptRows = (atts ?? []) as AttemptRow[]
  }

  const markedDoneAssignmentIds = new Set(
    assignmentRows.filter(a => a.marked_done_at).map(a => a.id)
  )
  const { isComplete } = buildAssignmentCompletion(activityRows, markedDoneAssignmentIds, attemptRows)

  const assignments = assignmentRows.map((a) => {
    const rawSheet: unknown = Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets
    const sheet = rawSheet as RawSheetJoin
    return {
      id: a.id,
      assigned_at: a.assigned_at,
      completed: isComplete(a.id, a.study_sheet_id),
      study_sheet: {
        title: sheet?.title ?? '—',
        category: sheet?.category ?? '—',
        level: sheet?.level ?? '—',
      },
    }
  })

  const now = new Date()
  const upcomingLessons = lessons?.filter(l => new Date(l.scheduled_at) >= now) ?? []
  const pastLessons = lessons?.filter(l => new Date(l.scheduled_at) < now) ?? []

  return (
    <StudentDetailClient
      training={training as unknown as Parameters<typeof StudentDetailClient>[0]['training']}
      upcomingLessons={upcomingLessons as unknown as Parameters<typeof StudentDetailClient>[0]['upcomingLessons']}
      pastLessons={pastLessons as unknown as Parameters<typeof StudentDetailClient>[0]['pastLessons']}
      reports={reports ?? []}
      isAdmin={isAdmin}
      viewerTz={viewerTz}
      currentUserId={user.id}
      assignments={assignments}
      assignedTeacherNames={assignedTeacherNames}
      materialAssignments={materialAssignments}
      materialLoadFailed={Boolean(materialError)}
    />
  )
}
