import type { createAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Create the "pending" report row that pairs 1:1 with a newly-created lesson.
 *
 * This is the row the teacher later fills in via the complete_report_atomic
 * RPC, which updates WHERE status IN ('pending','reopened'); so the row must
 * be inserted with status 'pending' to be reachable by that completion path.
 *
 * The UNIQUE index on reports.lesson_id (reports_lesson_id_key) makes a second
 * report for the same lesson impossible at the DB level; pairing it with an
 * upsert using ignoreDuplicates makes a retry (or a double-fire) safe: a
 * duplicate is silently skipped instead of raising a conflict error.
 *
 * deadline_at is the class-end instant plus 12 hours. The class end is a true
 * instant, so .toISOString() is the correct serialisation here; this is NOT
 * toISOString()-for-local-date construction.
 *
 * Returns { error }; it never throws. The caller decides what to do on error
 * and must never let a failure here block the booking it accompanies.
 */
export async function createPendingReport(
  adminClient: AdminClient,
  lessonId: string,
  teacherId: string,
  classEndsAtIso: string,
) {
  const deadlineAt = new Date(new Date(classEndsAtIso).getTime() + 12 * 60 * 60 * 1000).toISOString()

  const { error } = await adminClient
    .from('reports')
    .upsert(
      {
        lesson_id: lessonId,
        teacher_id: teacherId,
        status: 'pending',
        deadline_at: deadlineAt,
      },
      { onConflict: 'lesson_id', ignoreDuplicates: true },
    )

  return { error }
}
