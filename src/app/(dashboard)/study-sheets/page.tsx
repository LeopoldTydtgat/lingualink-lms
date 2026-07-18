import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import StudySheetsClient from './StudySheetsClient'

type SheetProgress = {
  assignedCount: number
  completedCount: number
  pendingCount: number
  latestAssignedAt: string | null
  activityCount: number
}

type AssignableStudent = { id: string; full_name: string; email: string }

export default async function StudySheetsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  // House rule: a null profile is NOT an unauthenticated user - never redirect.
  // Render a plain fallback instead.
  if (!profile) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <p className="text-sm" style={{ color: '#4b5563' }}>
          Your profile could not be loaded. Please refresh the page or contact support.
        </p>
      </div>
    )
  }

  // NEW373: mirror requireAdmin.ts exactly - role = 'admin' OR account_types
  // containing 'school_admin'. No variant.
  const isAdmin =
    profile.role === 'admin' ||
    (Array.isArray(profile.account_types) && profile.account_types.includes('school_admin'))

  // Existing user-scoped sheet fetch - unchanged.
  const { data: studySheets } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active, created_at, audience, owner_id')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  const sheets = studySheets ?? []

  // --- Student Worksheets progress aggregates (NEW345 step 4) --------------
  // Aggregate reads use the service-role client and are gated in JS by the
  // teacher's Condition-B student set (null = admin, no student filter). This
  // mirrors students/page.tsx: the assignments teacher RLS policy only exposes
  // rows the teacher personally assigned, so a user-scoped read here would be
  // blind to admin-assigned worksheets and to other teachers' assignments.
  const adminClient = createAdminClient()
  const scopedStudentIds = await getTeacherScopedStudentIds(adminClient, user.id, isAdmin)

  // Assignable roster for the "Assign to Students" modal. RLS blocks the teacher
  // role from reading the students table directly, so this must be a service-role
  // read, scoped to the teacher's Condition-B set (admin = all current students;
  // a teacher with an empty scoped set fetches nothing). full_name is the students
  // name column (verified: students has full_name NOT NULL, no first/last split).
  let assignableStudents: AssignableStudent[] = []
  if (scopedStudentIds === null) {
    const { data } = await adminClient
      .from('students')
      .select('id, full_name, email')
      .eq('status', 'current')
      .order('full_name')
    assignableStudents = (data ?? []) as AssignableStudent[]
  } else if (scopedStudentIds.length > 0) {
    const { data } = await adminClient
      .from('students')
      .select('id, full_name, email')
      .in('id', scopedStudentIds)
      .eq('status', 'current')
      .order('full_name')
    assignableStudents = (data ?? []) as AssignableStudent[]
  }

  const studentSheetIds = sheets
    .filter(s => s.audience === 'student')
    .map(s => s.id)

  type AssignmentRow = { id: string; study_sheet_id: string; student_id: string; assigned_at: string; marked_done_at: string | null }
  type ActivityRow = { id: string; sheet_id: string }
  type AttemptRow = { activity_id: string; assignment_id: string | null; created_at: string }

  // A teacher with no booked-class students ([]) reads nothing; admin (null) is unfiltered.
  const hasScopeRows = scopedStudentIds === null || scopedStudentIds.length > 0

  let assignmentRows: AssignmentRow[] = []
  if (studentSheetIds.length > 0 && hasScopeRows) {
    let q = adminClient
      .from('assignments')
      .select('id, study_sheet_id, student_id, assigned_at, marked_done_at')
      .in('study_sheet_id', studentSheetIds)
    if (scopedStudentIds !== null) q = q.in('student_id', scopedStudentIds)
    const { data } = await q
    assignmentRows = (data ?? []) as AssignmentRow[]
  }

  const assignmentIds = assignmentRows.map(a => a.id)

  // activities has NO is_active column (verified: 20260715120000 migration create
  // table lists id, sheet_id, position, type, title, content, answer_key, timestamps).
  let activityRows: ActivityRow[] = []
  if (studentSheetIds.length > 0) {
    const { data } = await adminClient
      .from('activities')
      .select('id, sheet_id')
      .in('sheet_id', studentSheetIds)
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

  // Pending review-queue count for the header entry point (NEW345 step 5). Counted
  // the same way the /study-sheets/reviews page builds its list: needs_review
  // attempts in the teacher's Condition-B scope whose activity is a writing_task
  // (assignment-independent — attempts can carry a null assignment_id, so the
  // assignment-scoped attemptRows above cannot be reused).
  let pendingReviewCount = 0
  if (hasScopeRows) {
    let rq = adminClient
      .from('activity_attempts')
      .select('id, activity_id')
      .eq('needs_review', true)
    if (scopedStudentIds !== null) rq = rq.in('student_id', scopedStudentIds)
    const { data: reviewData } = await rq
    const pendingRows = (reviewData ?? []) as { id: string; activity_id: string }[]
    if (pendingRows.length > 0) {
      const pendingActivityIds = [...new Set(pendingRows.map(r => r.activity_id))]
      const { data: wtData } = await adminClient
        .from('activities')
        .select('id')
        .in('id', pendingActivityIds)
        .eq('type', 'writing_task')
      const writingTaskIds = new Set(((wtData ?? []) as { id: string }[]).map(a => a.id))
      pendingReviewCount = pendingRows.filter(r => writingTaskIds.has(r.activity_id)).length
    }
  }

  // Bimodal completion rule, single-sourced (see lib/study/assignmentCompletion).
  const markedDoneAssignmentIds = new Set(
    assignmentRows.filter(a => a.marked_done_at).map(a => a.id)
  )
  const { isComplete, activityIdsBySheet } = buildAssignmentCompletion(
    activityRows,
    markedDoneAssignmentIds,
    attemptRows,
  )

  const progressBySheet: Record<string, SheetProgress> = {}
  for (const sheetId of studentSheetIds) {
    const rows = assignmentRows.filter(a => a.study_sheet_id === sheetId)
    // student_id -> has any completed assignment for this sheet.
    const byStudent = new Map<string, boolean>()
    let latest: string | null = null
    for (const r of rows) {
      if (latest === null || new Date(r.assigned_at) > new Date(latest)) latest = r.assigned_at
      const done = isComplete(r.id, sheetId)
      byStudent.set(r.student_id, (byStudent.get(r.student_id) ?? false) || done)
    }
    let assignedCount = 0
    let completedCount = 0
    for (const done of byStudent.values()) {
      assignedCount += 1
      if (done) completedCount += 1
    }
    progressBySheet[sheetId] = {
      assignedCount,
      completedCount,
      pendingCount: assignedCount - completedCount,
      latestAssignedAt: latest,
      activityCount: (activityIdsBySheet.get(sheetId) ?? []).length,
    }
  }

  // Rolling 7-day windows via instant math (never toISOString for boundaries).
  const nowMs = new Date().getTime()
  const weekAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000
  const assignedThisWeek = assignmentRows.filter(
    a => new Date(a.assigned_at).getTime() >= weekAgoMs
  ).length
  const newSubmissions =
    assignmentRows.filter(a => a.marked_done_at && new Date(a.marked_done_at).getTime() >= weekAgoMs).length +
    attemptRows.filter(t => new Date(t.created_at).getTime() >= weekAgoMs).length

  return (
    <StudySheetsClient
      studySheets={sheets}
      isAdmin={isAdmin}
      currentUserId={user.id}
      progressBySheet={progressBySheet}
      assignedThisWeek={assignedThisWeek}
      newSubmissions={newSubmissions}
      assignableStudents={assignableStudents}
      pendingReviewCount={pendingReviewCount}
    />
  )
}
