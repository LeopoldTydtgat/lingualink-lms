import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Condition B - training_ids on which `teacherUserId` holds an active booked-class
 * claim: an upcoming SCHEDULED lesson they personally hold (B1), or an open report
 * ('pending' in-window, or 'reopened' until completed) on one of their own lessons
 * (B2). Anchored strictly on lessons.teacher_id, so a reassigned lesson never leaks
 * its training to a former teacher. Lifted verbatim from students/page.tsx - no
 * behavioural change.
 */
export async function getActiveTrainingIds(
  admin: AdminClient,
  teacherUserId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const activeTrainingIds = new Set<string>()

  const { data: myLessons } = await admin
    .from('lessons')
    .select('id, training_id, status, scheduled_at')
    .eq('teacher_id', teacherUserId)

  type LessonRow = { id: string; training_id: string; status: string; scheduled_at: string | null }
  const lessonRows = (myLessons ?? []) as LessonRow[]

  // B1: an upcoming scheduled lesson keeps the training visible.
  for (const l of lessonRows) {
    if (l.status === 'scheduled' && l.scheduled_at && new Date(l.scheduled_at) > now) {
      activeTrainingIds.add(l.training_id)
    }
  }

  // B2: an open report on one of this teacher's lessons keeps the training visible. A
  // 'pending' report counts only while inside its window (deadline_at > now); a
  // 'reopened' report counts until it is completed - its deadline_at is stale, so the
  // window check is skipped for it. Matched only against this teacher's own lessons.
  const myLessonIds = lessonRows.map(l => l.id)
  if (myLessonIds.length > 0) {
    const lessonToTraining = new Map<string, string>(
      lessonRows.map(l => [l.id, l.training_id] as [string, string])
    )
    const { data: openReports } = await admin
      .from('reports')
      .select('lesson_id, status, deadline_at')
      .in('lesson_id', myLessonIds)
      .in('status', ['pending', 'reopened'])

    type ReportRow = { lesson_id: string; status: string; deadline_at: string | null }
    for (const r of ((openReports ?? []) as ReportRow[])) {
      if (r.status === 'reopened' || (r.deadline_at && new Date(r.deadline_at) > now)) {
        const tid = lessonToTraining.get(r.lesson_id)
        if (tid) activeTrainingIds.add(tid)
      }
    }
  }

  return activeTrainingIds
}

/**
 * The set of student_ids a teacher may see via Condition B: the students who own the
 * trainings in getActiveTrainingIds(). Used to gate the messages deep-link resolve and
 * the new-message picker.
 */
export async function getBookedClassStudentIds(
  admin: AdminClient,
  teacherUserId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const activeTrainingIds = await getActiveTrainingIds(admin, teacherUserId, now)
  if (activeTrainingIds.size === 0) return new Set<string>()

  const { data: rows } = await admin
    .from('trainings')
    .select('id, student_id')
    .in('id', [...activeTrainingIds])

  type TrainingRow = { id: string; student_id: string }
  const studentIds = new Set<string>()
  for (const t of ((rows ?? []) as TrainingRow[])) {
    if (t.student_id) studentIds.add(t.student_id)
  }
  return studentIds
}
