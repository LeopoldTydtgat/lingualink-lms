import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * NEW275 — the single source of truth for messaging access on BOTH portals.
 *
 * A teacher and a student may message each other iff the teacher is assigned to one of
 * the student's trainings via the `training_teachers` junction. Bookings are irrelevant.
 * The `messages` RLS INSERT policies only check the sender, so the app-level checks that
 * call these helpers are LOAD-BEARING security.
 *
 * Contract: both helpers THROW on any Supabase query error, so callers can distinguish a
 * genuine verification failure ("Could not verify access") from a legitimate deny. An
 * empty set means the person genuinely has no assignments (a fail-closed deny). Callers
 * MUST wrap these in try/catch — never treat a thrown error as "no assignments".
 *
 * The admin client is passed in (bypasses RLS) exactly as `bookedClass.ts` does; callers
 * must have already established the identity they scope by (student.id / teacher auth id).
 */

/**
 * The distinct teacher ids (`training_teachers.teacher_id` → `profiles.id`) assigned to
 * `studentId` across all of that student's trainings. Throws on query error; empty set
 * means genuinely no assignments.
 */
export async function getAssignedTeacherIds(
  admin: AdminClient,
  studentId: string,
): Promise<Set<string>> {
  const { data: trainings, error: trainingsError } = await admin
    .from('trainings')
    .select('id')
    .eq('student_id', studentId)
  if (trainingsError) throw trainingsError
  if (!trainings || trainings.length === 0) {
    return new Set<string>()
  }

  const trainingIds = trainings.map((t) => t.id)
  const { data: rows, error: assignmentError } = await admin
    .from('training_teachers')
    .select('teacher_id')
    .in('training_id', trainingIds)
  if (assignmentError) throw assignmentError
  if (!rows) {
    return new Set<string>()
  }

  const teacherIds = new Set<string>()
  for (const r of rows) {
    if (r.teacher_id) teacherIds.add(r.teacher_id)
  }
  return teacherIds
}

/**
 * The distinct student ids (`trainings.student_id` → `students.id`) assigned to
 * `teacherId`, reached by joining `training_teachers` (teacher_id) → `trainings`. Note
 * `trainings.teacher_id` is a dead legacy column and is never consulted. Throws on query
 * error; empty set means genuinely no assignments.
 */
export async function getAssignedStudentIds(
  admin: AdminClient,
  teacherId: string,
): Promise<Set<string>> {
  const { data: assignments, error: assignmentError } = await admin
    .from('training_teachers')
    .select('training_id')
    .eq('teacher_id', teacherId)
  if (assignmentError) throw assignmentError
  if (!assignments || assignments.length === 0) {
    return new Set<string>()
  }

  const trainingIds = assignments.map((a) => a.training_id)
  const { data: rows, error: trainingsError } = await admin
    .from('trainings')
    .select('student_id')
    .in('id', trainingIds)
  if (trainingsError) throw trainingsError
  if (!rows) {
    return new Set<string>()
  }

  const studentIds = new Set<string>()
  for (const r of rows) {
    if (r.student_id) studentIds.add(r.student_id)
  }
  return studentIds
}
