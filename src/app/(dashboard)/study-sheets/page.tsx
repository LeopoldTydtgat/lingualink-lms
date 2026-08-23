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

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[dashboard/study-sheets] profiles lookup failed:', profileError)
  }

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

  // NEW373: mirror requireAdmin.ts exactly - role = 'admin'. No variant.
  const isAdmin = profile.role === 'admin'

  // Existing user-scoped sheet fetch - unchanged.
  const { data: studySheets, error: studySheetsError } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active, created_at, audience, owner_id, attachments')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  // FATAL: every figure and both lists on this page derive from this one read.
  // Absorbed into `?? []` it would render "0 resources / 0 worksheets" over two
  // empty-state cards, byte-identical to a brand-new teacher's real library -
  // there is nothing left to degrade. Surfaced in-page rather than thrown: there
  // is no (dashboard) error boundary, so a throw renders app/error.tsx and blanks
  // the whole portal shell (see (dashboard)/layout.tsx:46-48 on that hazard).
  if (studySheetsError) {
    console.error('[dashboard/study-sheets] study_sheets lookup failed:', studySheetsError)
    return (
      <div className="p-8 text-gray-500">Unable to load your library. Please refresh the page.</div>
    )
  }

  const sheets = studySheets ?? []

  // --- Student Worksheets progress aggregates (NEW345 step 4) --------------
  // Aggregate reads use the service-role client and are gated in JS by the
  // teacher's Condition-B student set (null = admin, no student filter). This
  // mirrors students/page.tsx: the assignments teacher RLS policy only exposes
  // rows the teacher personally assigned, so a user-scoped read here would be
  // blind to admin-assigned worksheets and to other teachers' assignments.
  const adminClient = createAdminClient()
  // KNOWN GAP (separate commit): getTeacherScopedStudentIds swallows the errors of
  // its own lessons/reports/trainings reads and returns [] on failure, which lands
  // on the same false empty state every flag below exists to prevent - silently, and
  // for the roster as well as the figures. That fix belongs in lib/access/bookedClass.ts
  // and has five callers. Recorded here to match [id]/responses/page.tsx:98-100.
  const scopedStudentIds = await getTeacherScopedStudentIds(adminClient, user.id, isAdmin)

  // Assignable roster for the "Assign to Students" modal. RLS blocks the teacher
  // role from reading the students table directly, so this must be a service-role
  // read, scoped to the teacher's Condition-B set (admin = all current students;
  // a teacher with an empty scoped set fetches nothing). full_name is the students
  // name column (verified: students has full_name NOT NULL, no first/last split).
  //
  // Roster-only failure: nothing else on the page reads it, so this DEGRADES the
  // assign modal rather than the page. Absorbed into `?? []` it makes the modal
  // claim "You have no students to assign to yet." - a positive statement about
  // the teacher's roster that a failed read must never make. A teacher whose
  // scoped set is legitimately empty runs neither branch, so the flag stays
  // false: no query ran, so no query failed.
  let rosterLoadFailed = false
  let assignableStudents: AssignableStudent[] = []
  if (scopedStudentIds === null) {
    const { data, error: rosterError } = await adminClient
      .from('students')
      .select('id, full_name, email')
      .eq('status', 'current')
      .order('full_name')
    if (rosterError) {
      console.error('[dashboard/study-sheets] students lookup failed (all current):', rosterError)
      rosterLoadFailed = true
    }
    assignableStudents = (data ?? []) as AssignableStudent[]
  } else if (scopedStudentIds.length > 0) {
    const { data, error: rosterError } = await adminClient
      .from('students')
      .select('id, full_name, email')
      .in('id', scopedStudentIds)
      .eq('status', 'current')
      .order('full_name')
    if (rosterError) {
      console.error('[dashboard/study-sheets] students lookup failed (scoped):', rosterError)
      rosterLoadFailed = true
    }
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

  // ONE flag across the three reads that feed the worksheet progress figures.
  // They fail asymmetrically and that is the whole hazard: `assignments` supplies
  // assignedCount, while `activities` and `activity_attempts` supply the evidence
  // of completion. Lose either of the latter and buildAssignmentCompletion silently
  // degrades to the marked_done_at arm alone, so a fully-completed worksheet still
  // renders its denominator but asserts "Completed 0 / Pending N" over a 0% bar -
  // a wrong number rather than an absent one. Any one failure therefore suppresses
  // the whole progress claim, and the client shows an error card in its place.
  let progressLoadFailed = false

  let assignmentRows: AssignmentRow[] = []
  if (studentSheetIds.length > 0 && hasScopeRows) {
    let q = adminClient
      .from('assignments')
      .select('id, study_sheet_id, student_id, assigned_at, marked_done_at')
      .in('study_sheet_id', studentSheetIds)
    if (scopedStudentIds !== null) q = q.in('student_id', scopedStudentIds)
    const { data, error: assignmentsError } = await q
    if (assignmentsError) {
      console.error('[dashboard/study-sheets] assignments lookup failed:', assignmentsError)
      progressLoadFailed = true
    }
    assignmentRows = (data ?? []) as AssignmentRow[]
  }

  const assignmentIds = assignmentRows.map(a => a.id)

  // activities has NO is_active column (verified: 20260715120000 migration create
  // table lists id, sheet_id, position, type, title, content, answer_key, timestamps).
  let activityRows: ActivityRow[] = []
  if (studentSheetIds.length > 0) {
    const { data, error: activitiesError } = await adminClient
      .from('activities')
      .select('id, sheet_id')
      .in('sheet_id', studentSheetIds)
    if (activitiesError) {
      console.error('[dashboard/study-sheets] activities lookup failed:', activitiesError)
      progressLoadFailed = true
    }
    activityRows = (data ?? []) as ActivityRow[]
  }

  let attemptRows: AttemptRow[] = []
  if (assignmentIds.length > 0) {
    const { data: atts, error: attemptsError } = await adminClient
      .from('activity_attempts')
      .select('activity_id, assignment_id, created_at')
      .in('assignment_id', assignmentIds)
    if (attemptsError) {
      console.error('[dashboard/study-sheets] activity_attempts lookup failed:', attemptsError)
      progressLoadFailed = true
    }
    attemptRows = (atts ?? []) as AttemptRow[]
  }

  // Pending review-queue count for the header entry point (NEW345 step 5). Counted
  // the same way the /study-sheets/reviews page builds its list: needs_review
  // attempts in the teacher's Condition-B scope whose activity is a writing_task
  // (assignment-independent — attempts can carry a null assignment_id, so the
  // assignment-scoped attemptRows above cannot be reused).
  // Its own flag: the count is a badge, not a figure the teacher acts on here,
  // and the button beside it stays live either way - it is a route to the truth
  // rather than a claim about it. Either read failing zeroes the count (a missing
  // writing_task set drops every row at the filter below), so both set the flag.
  let reviewCountLoadFailed = false
  let pendingReviewCount = 0
  if (hasScopeRows) {
    let rq = adminClient
      .from('activity_attempts')
      .select('id, activity_id')
      .eq('needs_review', true)
    if (scopedStudentIds !== null) rq = rq.in('student_id', scopedStudentIds)
    const { data: reviewData, error: reviewError } = await rq
    if (reviewError) {
      console.error('[dashboard/study-sheets] activity_attempts (needs_review) lookup failed:', reviewError)
      reviewCountLoadFailed = true
    }
    const pendingRows = (reviewData ?? []) as { id: string; activity_id: string }[]
    if (pendingRows.length > 0) {
      const pendingActivityIds = [...new Set(pendingRows.map(r => r.activity_id))]
      const { data: wtData, error: writingTaskError } = await adminClient
        .from('activities')
        .select('id')
        .in('id', pendingActivityIds)
        .eq('type', 'writing_task')
      if (writingTaskError) {
        console.error('[dashboard/study-sheets] activities (writing_task) lookup failed:', writingTaskError)
        reviewCountLoadFailed = true
      }
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

  // The three derived figures cross as null, not as their computed 0: both stat
  // cards and the review badge are counts a teacher reads as fact, and 0 is a
  // fact. Nulled at the boundary rather than in the client so the prop type
  // itself carries the distinction and no consumer can render the 0 by accident.
  return (
    <StudySheetsClient
      studySheets={sheets}
      currentUserId={user.id}
      progressBySheet={progressBySheet}
      assignedThisWeek={progressLoadFailed ? null : assignedThisWeek}
      newSubmissions={progressLoadFailed ? null : newSubmissions}
      assignableStudents={assignableStudents}
      pendingReviewCount={reviewCountLoadFailed ? null : pendingReviewCount}
      progressLoadFailed={progressLoadFailed}
      rosterLoadFailed={rosterLoadFailed}
    />
  )
}
