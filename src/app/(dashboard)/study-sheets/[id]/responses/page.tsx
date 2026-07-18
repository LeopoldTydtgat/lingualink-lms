import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'
import { buildAssignmentCompletion } from '@/lib/study/assignmentCompletion'
import { McqContentSchema, McqAnswerKeySchema } from '@/lib/validation/activities'
import ResponsesClient, {
  type StudentResponses,
  type ActivityResponses,
  type QuestionResult,
} from './ResponsesClient'

// Teacher/admin read-only drill-down of student worksheet responses (NEW345 C3).
// All reads use the service-role client, gated in JS by the teacher's Condition-B
// student set - identical scoping to the C1 aggregates. The activity_attempts RLS
// teacher policy is deliberately NOT relied on: its trainings scope diverges from
// Condition B and would show a different student set than the worksheet cards.
export default async function WorksheetResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  // House rule: a null profile is NOT an unauthenticated user - never redirect.
  if (!profile) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <p className="text-sm" style={{ color: '#4b5563' }}>
          Your profile could not be loaded. Please refresh the page or contact support.
        </p>
      </div>
    )
  }

  // Mirror the assign route: role teacher OR admin/school_admin. This surface
  // uses the admin client, so the gate must be explicit (no RLS backstop).
  const isAdmin =
    profile.role === 'admin' ||
    (Array.isArray(profile.account_types) && profile.account_types.includes('school_admin'))
  const isAuthorized = profile.role === 'teacher' || isAdmin
  if (!isAuthorized) notFound()

  const adminClient = createAdminClient()

  // Sheet eligibility mirrors the C2 assign route exactly: an active, admin-published
  // student worksheet (audience='student', owner_id IS NULL). Anything else 404s.
  const { data: sheet } = await adminClient
    .from('study_sheets')
    .select('id, title, category, level, is_active, audience, owner_id')
    .eq('id', id)
    .maybeSingle()

  if (
    !sheet ||
    sheet.is_active !== true ||
    sheet.audience !== 'student' ||
    sheet.owner_id !== null
  ) {
    notFound()
  }

  // Condition-B scope: null = admin (no student filter); [] = a teacher with no
  // booked-class students (can have no in-scope assignments -> empty state).
  const scopedStudentIds = await getTeacherScopedStudentIds(adminClient, user.id, isAdmin)
  const hasScopeRows = scopedStudentIds === null || scopedStudentIds.length > 0

  // Assignments for this sheet, scoped to the teacher's students.
  type AssignmentRow = { id: string; student_id: string; assigned_at: string }
  let assignmentRows: AssignmentRow[] = []
  if (hasScopeRows) {
    let q = adminClient
      .from('assignments')
      .select('id, student_id, assigned_at')
      .eq('study_sheet_id', id)
    if (scopedStudentIds !== null) q = q.in('student_id', scopedStudentIds)
    const { data } = await q
    assignmentRows = (data ?? []) as AssignmentRow[]
  }

  const studentIds = [...new Set(assignmentRows.map(a => a.student_id))]

  // Empty state: no in-scope student has this worksheet.
  if (assignmentRows.length === 0 || studentIds.length === 0) {
    return (
      <ResponsesClient
        sheetTitle={sheet.title}
        sheetCategory={sheet.category}
        sheetLevel={sheet.level}
        students={[]}
      />
    )
  }

  const assignmentIds = assignmentRows.map(a => a.id)
  const studentByAssignment = new Map<string, string>()
  for (const a of assignmentRows) studentByAssignment.set(a.id, a.student_id)

  // Activities for this sheet (admin client also carries answer_key - resolved
  // server-side below and NEVER passed to the client). position orders display.
  type ActivityRow = {
    id: string
    position: number | null
    type: string
    title: string | null
    content: unknown
    answer_key: unknown
  }
  const { data: activityData } = await adminClient
    .from('activities')
    .select('id, position, type, title, content, answer_key')
    .eq('sheet_id', id)
    .order('position', { ascending: true })
  const activityRows = (activityData ?? []) as ActivityRow[]

  // Student names (service-role read; teacher role cannot read students directly).
  const { data: studentData } = await adminClient
    .from('students')
    .select('id, full_name')
    .in('id', studentIds)
  const nameById = new Map<string, string>()
  for (const s of ((studentData ?? []) as { id: string; full_name: string }[])) {
    nameById.set(s.id, s.full_name)
  }

  // Completion + attempt rows, keyed to this sheet's assignments.
  type CompletionRow = { assignment_id: string | null; completed_at: string }
  type AttemptRow = {
    activity_id: string
    assignment_id: string | null
    answers: unknown
    score: number | null
    created_at: string
  }
  const [{ data: comps }, { data: atts }] = await Promise.all([
    adminClient
      .from('exercise_completions')
      .select('assignment_id, completed_at')
      .in('assignment_id', assignmentIds),
    adminClient
      .from('activity_attempts')
      .select('activity_id, assignment_id, answers, score, created_at')
      .in('assignment_id', assignmentIds),
  ])
  const completionRows = (comps ?? []) as CompletionRow[]
  const attemptRows = (atts ?? []) as AttemptRow[]

  // Shared bimodal completion rule (single-sourced with the C1 aggregates).
  const { isComplete } = buildAssignmentCompletion(
    activityRows.map(a => ({ id: a.id, sheet_id: id })),
    completionRows,
    attemptRows.map(t => ({ activity_id: t.activity_id, assignment_id: t.assignment_id })),
  )

  // Latest attempt per (student, activity) across all of that student's
  // assignments for this sheet. Append-only table -> newest created_at wins.
  const latestAttempt = new Map<string, AttemptRow>()
  for (const t of attemptRows) {
    if (!t.assignment_id) continue
    const sid = studentByAssignment.get(t.assignment_id)
    if (!sid) continue
    const key = `${sid}::${t.activity_id}`
    const prev = latestAttempt.get(key)
    if (!prev || new Date(t.created_at) > new Date(prev.created_at)) {
      latestAttempt.set(key, t)
    }
  }

  // Assignments grouped by student (a student may hold more than one for a sheet).
  const assignmentsByStudent = new Map<string, AssignmentRow[]>()
  for (const a of assignmentRows) {
    const arr = assignmentsByStudent.get(a.student_id) ?? []
    arr.push(a)
    assignmentsByStudent.set(a.student_id, arr)
  }

  // Parse each activity's content + answer key ONCE. NEW371: a malformed or
  // non-MCQ activity yields an empty question set - never throws, never 500s.
  type ParsedActivity = {
    id: string
    title: string
    isMcq: boolean
    questions: { id: string; text: string; options: string[] }[]
    correctByQid: Map<string, string>
  }
  const parsedActivities: ParsedActivity[] = activityRows.map((a) => {
    const content = a.type === 'mcq' ? McqContentSchema.safeParse(a.content) : null
    const key = a.type === 'mcq' ? McqAnswerKeySchema.safeParse(a.answer_key) : null
    const correctByQid = new Map<string, string>()
    if (key?.success) {
      for (const [qid, entry] of Object.entries(key.data.questions)) {
        correctByQid.set(qid, entry.correct_answer)
      }
    }
    return {
      id: a.id,
      title: a.title ?? 'Activity',
      isMcq: a.type === 'mcq',
      questions: content?.success
        ? content.data.questions.map(q => ({ id: q.id, text: q.question_text, options: q.options }))
        : [],
      correctByQid,
    }
  })

  // Resolve fully server-side. Only plain, answer-key-free data crosses to the client.
  const students: StudentResponses[] = studentIds
    .map((sid): StudentResponses => {
      const myAssignments = assignmentsByStudent.get(sid) ?? []
      const completed = myAssignments.some(a => isComplete(a.id, id))
      const latestAssignedAt = myAssignments.reduce<string | null>((acc, a) => {
        if (acc === null || new Date(a.assigned_at) > new Date(acc)) return a.assigned_at
        return acc
      }, null)

      let attemptedCount = 0
      let scoreSum = 0
      let scoreCount = 0
      let latestAttemptAt: string | null = null

      const activities: ActivityResponses[] = parsedActivities.map((pa): ActivityResponses => {
        const attempt = latestAttempt.get(`${sid}::${pa.id}`)
        const attempted = attempt !== undefined
        if (attempted) {
          attemptedCount += 1
          if (typeof attempt.score === 'number') {
            scoreSum += attempt.score
            scoreCount += 1
          }
          if (latestAttemptAt === null || new Date(attempt.created_at) > new Date(latestAttemptAt)) {
            latestAttemptAt = attempt.created_at
          }
        }

        // Stored answers: Record<questionId, selectedOptionText>. Own-property
        // lookups only, so a qid like 'toString' cannot resolve off the prototype.
        const rawAnswers = (attempt?.answers ?? {}) as Record<string, unknown>
        const answerFor = (qid: string): string | null => {
          if (!Object.hasOwn(rawAnswers, qid)) return null
          const v = rawAnswers[qid]
          return typeof v === 'string' ? v : null
        }

        const currentQids = new Set(pa.questions.map(q => q.id))
        const questions: QuestionResult[] = []

        // Current questions, in authored order.
        for (const q of pa.questions) {
          const studentAnswer = answerFor(q.id)
          const correctAnswer = pa.correctByQid.get(q.id) ?? null
          // NEW371: a stored answer no longer present among the current options
          // means the activity changed after this attempt was taken.
          const contentMismatch =
            studentAnswer !== null &&
            !q.options.some(o => o.trim() === studentAnswer.trim())
          let isCorrect: boolean | null = null
          if (!contentMismatch && studentAnswer !== null && correctAnswer !== null) {
            isCorrect = studentAnswer.trim() === correctAnswer.trim()
          }
          questions.push({
            qid: q.id,
            questionText: q.text,
            options: q.options,
            studentAnswer,
            correctAnswer,
            isCorrect,
            contentMismatch,
          })
        }

        // Orphan answers: stored answers whose question no longer exists in the
        // current content. Always a content mismatch (NEW371); correctness unknown.
        if (attempted) {
          for (const qid of Object.keys(rawAnswers)) {
            if (currentQids.has(qid)) continue
            questions.push({
              qid,
              questionText: null,
              options: [],
              studentAnswer: answerFor(qid),
              correctAnswer: pa.correctByQid.get(qid) ?? null,
              isCorrect: null,
              contentMismatch: true,
            })
          }
        }

        return {
          activityId: pa.id,
          activityTitle: pa.title,
          isGradable: pa.isMcq,
          attempted,
          // Stored score is authoritative - never recomputed here.
          score: attempt?.score ?? null,
          questions,
        }
      })

      const avgScore = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null

      return {
        studentId: sid,
        studentName: nameById.get(sid) ?? 'Student',
        completed,
        attemptedActivityCount: attemptedCount,
        totalActivityCount: parsedActivities.length,
        avgScore,
        latestAssignedAt,
        latestAttemptAt,
        activities,
      }
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName))

  return (
    <ResponsesClient
      sheetTitle={sheet.title}
      sheetCategory={sheet.category}
      sheetLevel={sheet.level}
      students={students}
    />
  )
}
