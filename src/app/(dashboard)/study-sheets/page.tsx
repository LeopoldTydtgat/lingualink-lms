import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'
import StudySheetsClient from './StudySheetsClient'

type SheetProgress = {
  assignedCount: number
  completedCount: number
  pendingCount: number
  latestAssignedAt: string | null
  activityCount: number
}

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

  const studentSheetIds = sheets
    .filter(s => s.audience === 'student')
    .map(s => s.id)

  type AssignmentRow = { id: string; study_sheet_id: string; student_id: string; assigned_at: string }
  type ActivityRow = { id: string; sheet_id: string }
  type CompletionRow = { assignment_id: string | null; completed_at: string }
  type AttemptRow = { activity_id: string; assignment_id: string | null; created_at: string }

  // A teacher with no booked-class students ([]) reads nothing; admin (null) is unfiltered.
  const hasScopeRows = scopedStudentIds === null || scopedStudentIds.length > 0

  let assignmentRows: AssignmentRow[] = []
  if (studentSheetIds.length > 0 && hasScopeRows) {
    let q = adminClient
      .from('assignments')
      .select('id, study_sheet_id, student_id, assigned_at')
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

  let completionRows: CompletionRow[] = []
  let attemptRows: AttemptRow[] = []
  if (assignmentIds.length > 0) {
    const [{ data: comps }, { data: atts }] = await Promise.all([
      adminClient
        .from('exercise_completions')
        .select('assignment_id, completed_at')
        .in('assignment_id', assignmentIds),
      adminClient
        .from('activity_attempts')
        .select('activity_id, assignment_id, created_at')
        .in('assignment_id', assignmentIds),
    ])
    completionRows = (comps ?? []) as CompletionRow[]
    attemptRows = (atts ?? []) as AttemptRow[]
  }

  // Lookups.
  const activitiesBySheet = new Map<string, string[]>()
  for (const a of activityRows) {
    const arr = activitiesBySheet.get(a.sheet_id) ?? []
    arr.push(a.id)
    activitiesBySheet.set(a.sheet_id, arr)
  }

  // Legacy path: an exercise_completions row keyed to the assignment means done.
  const legacyDoneAssignments = new Set<string>()
  for (const c of completionRows) {
    if (c.assignment_id) legacyDoneAssignments.add(c.assignment_id)
  }

  // NEW345 path: which activities each assignment has an attempt for.
  const attemptsByAssignment = new Map<string, Set<string>>()
  for (const t of attemptRows) {
    if (!t.assignment_id) continue
    const set = attemptsByAssignment.get(t.assignment_id) ?? new Set<string>()
    set.add(t.activity_id)
    attemptsByAssignment.set(t.assignment_id, set)
  }

  // An assignment is complete when a legacy completion row exists for it, OR the
  // sheet has activities and every one has an attempt under that assignment.
  function assignmentComplete(assignmentId: string, sheetId: string): boolean {
    if (legacyDoneAssignments.has(assignmentId)) return true
    const acts = activitiesBySheet.get(sheetId)
    if (acts && acts.length > 0) {
      const done = attemptsByAssignment.get(assignmentId)
      if (done && acts.every(id => done.has(id))) return true
    }
    return false
  }

  const progressBySheet: Record<string, SheetProgress> = {}
  for (const sheetId of studentSheetIds) {
    const rows = assignmentRows.filter(a => a.study_sheet_id === sheetId)
    // student_id -> has any completed assignment for this sheet.
    const byStudent = new Map<string, boolean>()
    let latest: string | null = null
    for (const r of rows) {
      if (latest === null || new Date(r.assigned_at) > new Date(latest)) latest = r.assigned_at
      const done = assignmentComplete(r.id, sheetId)
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
      activityCount: (activitiesBySheet.get(sheetId) ?? []).length,
    }
  }

  // Rolling 7-day windows via instant math (never toISOString for boundaries).
  const nowMs = new Date().getTime()
  const weekAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000
  const assignedThisWeek = assignmentRows.filter(
    a => new Date(a.assigned_at).getTime() >= weekAgoMs
  ).length
  const newSubmissions =
    completionRows.filter(c => new Date(c.completed_at).getTime() >= weekAgoMs).length +
    attemptRows.filter(t => new Date(t.created_at).getTime() >= weekAgoMs).length

  return (
    <StudySheetsClient
      studySheets={sheets}
      isAdmin={isAdmin}
      currentUserId={user.id}
      progressBySheet={progressBySheet}
      assignedThisWeek={assignedThisWeek}
      newSubmissions={newSubmissions}
    />
  )
}
