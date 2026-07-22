import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'
import { WritingTaskContentSchema } from '@/lib/validation/activities'
import ReviewQueueClient, { type ReviewItem } from './ReviewQueueClient'

// Teacher review queue for writing_task responses (NEW345 step 5, chunk C).
// All reads use the service-role client, gated in JS by the teacher's
// Condition-B student set — identical scoping to the C3 responses page. The
// activity_attempts RLS teacher policy is deliberately NOT relied on: its
// trainings scope diverges from Condition B and would show a different student
// set than the worksheet cards.
export default async function ReviewQueuePage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
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

  // Mirror the C3 responses page: role teacher OR admin. This surface uses the
  // admin client, so the gate must be explicit (no RLS backstop).
  const isAdmin = profile.role === 'admin'
  const isAuthorized = profile.role === 'teacher' || isAdmin
  if (!isAuthorized) notFound()

  const adminClient = createAdminClient()

  // Condition-B scope: null = admin (no student filter); [] = a teacher with no
  // booked-class students (nothing to review -> empty queue).
  const scopedStudentIds = await getTeacherScopedStudentIds(adminClient, user.id, isAdmin)
  const hasScopeRows = scopedStudentIds === null || scopedStudentIds.length > 0

  // Pending attempts, oldest first — longest-waiting response gets reviewed first.
  type AttemptRow = {
    id: string
    student_id: string
    activity_id: string
    answers: unknown
    created_at: string
  }
  let attemptRows: AttemptRow[] = []
  if (hasScopeRows) {
    let q = adminClient
      .from('activity_attempts')
      .select('id, student_id, activity_id, answers, created_at')
      .eq('needs_review', true)
      .order('created_at', { ascending: true })
    if (scopedStudentIds !== null) q = q.in('student_id', scopedStudentIds)
    const { data } = await q
    attemptRows = (data ?? []) as AttemptRow[]
  }

  // Joined data resolved in separate flat fetches — never nested joins.
  const activityIds = [...new Set(attemptRows.map(a => a.activity_id))]
  type ActivityRow = {
    id: string
    title: string | null
    content: unknown
    updated_at: string
    sheet_id: string
    type: string
  }
  let activityRows: ActivityRow[] = []
  if (activityIds.length > 0) {
    const { data } = await adminClient
      .from('activities')
      .select('id, title, content, updated_at, sheet_id, type')
      .in('id', activityIds)
    activityRows = (data ?? []) as ActivityRow[]
  }
  const activityById = new Map(activityRows.map(a => [a.id, a]))

  const sheetIds = [...new Set(activityRows.map(a => a.sheet_id))]
  let sheetRows: { id: string; title: string }[] = []
  if (sheetIds.length > 0) {
    const { data } = await adminClient
      .from('study_sheets')
      .select('id, title')
      .in('id', sheetIds)
    sheetRows = (data ?? []) as { id: string; title: string }[]
  }
  const sheetTitleById = new Map(sheetRows.map(s => [s.id, s.title]))

  const studentIds = [...new Set(attemptRows.map(a => a.student_id))]
  let studentRows: { id: string; full_name: string }[] = []
  if (studentIds.length > 0) {
    const { data } = await adminClient
      .from('students')
      .select('id, full_name')
      .in('id', studentIds)
    studentRows = (data ?? []) as { id: string; full_name: string }[]
  }
  const nameById = new Map(studentRows.map(s => [s.id, s.full_name]))

  // Resolve fully server-side; only plain display data crosses to the client.
  const items: ReviewItem[] = []
  for (const att of attemptRows) {
    const activity = activityById.get(att.activity_id)
    // Only writing tasks are reviewable in this queue — MCQ feedback is out of
    // scope this chunk, and the review route 422s on anything else anyway.
    if (!activity || activity.type !== 'writing_task') continue

    // Malformed authored content renders a safe message, never throws.
    const parsedContent = WritingTaskContentSchema.safeParse(activity.content)

    // answers is jsonb; pull response_text defensively rather than trusting
    // shape (same extraction as the student player page).
    const rawAnswers = att.answers
    const responseText =
      rawAnswers && typeof rawAnswers === 'object' &&
      typeof (rawAnswers as { response_text?: unknown }).response_text === 'string'
        ? (rawAnswers as { response_text: string }).response_text
        : ''

    items.push({
      attemptId: att.id,
      studentName: nameById.get(att.student_id) ?? 'Student',
      activityTitle: activity.title ?? 'Writing task',
      sheetTitle: sheetTitleById.get(activity.sheet_id) ?? 'Worksheet',
      submittedAt: att.created_at,
      prompt: parsedContent.success ? parsedContent.data.prompt : null,
      responseText,
      // NEW371: the prompt was edited after this response was submitted.
      promptEditedAfterSubmission:
        new Date(activity.updated_at).getTime() > new Date(att.created_at).getTime(),
    })
  }

  return <ReviewQueueClient items={items} />
}
