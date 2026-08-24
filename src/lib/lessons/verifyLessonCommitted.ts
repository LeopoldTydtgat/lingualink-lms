import type { createAdminClient } from '@/lib/supabase/admin'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'

// ---------------------------------------------------------------------------
// Did the lesson insert actually commit?
//
// WHY THIS EXISTS
//
// Both booking routes (/api/student/book, /api/admin/classes) deduct hours or
// run a reschedule RPC BEFORE inserting the lesson, and own the compensating
// reversal until that insert lands. That contract only works while the caller
// can tell what the insert did.
//
// It cannot always tell. When the insert's RESPONSE is lost - a socket reset, a
// serverless timeout, a fetch-level throw - the caller holds an error object
// that says nothing about the transaction. Two states are indistinguishable
// from where it stands:
//
//   - the statement never committed: no row exists, and the hours the route
//     already took must be given back;
//   - the statement DID commit and only the reply died: a real, bookable class
//     now exists on the calendar.
//
// Guessing is expensive in both directions. Refunding against a COMMITTED
// lesson cancels a live class: the student is credited back for a class that is
// still on the calendar and that a teacher will still teach. NOT refunding
// against a ROLLED-BACK one silently keeps hours the student never spent.
//
// So the caller asks the database instead of guessing. This helper reads the
// lessons table back and returns one of three verdicts. 'unresolved' is a real,
// expected answer - it means "do not compensate automatically, raise it for a
// human" - and is never dressed up as either of the other two.
//
// Nothing here writes. It is safe to call from inside a failure handler, and it
// never throws (see the try/catch below): every call site is already handling a
// failure, and a throw from here would replace a handled booking failure with
// an unhandled one on the money path.
// ---------------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>

export type LessonCommitVerdict =
  | { outcome: 'committed'; lessonId: string }
  | { outcome: 'not_committed' }
  | { outcome: 'unresolved'; reason: 'verify_failed' | 'ambiguous_row'; detail?: unknown }

export type VerifyLessonCommittedParams = {
  teamsMeetingId: string | null
  teacherId: string
  studentId: string
  trainingId: string
  scheduledAtIso: string
  durationMinutes: number
  requestStartIso: string
}

// A Postgres SQLSTATE is exactly five characters drawn from digits and UPPERCASE
// letters ('23505', '23P01', 'P0001'). PostgREST's own client-side codes
// ('PGRST116', 'PGRST301') are longer and prefixed, so they fail the length test
// already; the explicit prefix guard below covers the bare 'PGRST', which is
// five uppercase characters and would otherwise slip through.
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/

/**
 * Does this error PROVE the insert's transaction rolled back?
 *
 * A SQLSTATE means the statement reached Postgres and Postgres rejected it. For
 * a single-statement INSERT that is conclusive: the statement is its own
 * transaction, a rejected statement rolls that transaction back, and no row
 * exists. The caller can compensate immediately, with no read-back.
 *
 * Everything else is UNPROVEN, not "committed": a thrown TypeError from fetch, a
 * timeout, a null error paired with a null row, a PGRST* code the client raised
 * after the fact. Unproven is the case this whole module exists to resolve, so
 * false must never be read as "the insert succeeded" - it means "go and look".
 */
export function isRollbackProven(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false

  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  if (!SQLSTATE_PATTERN.test(code)) return false

  return !code.startsWith('PGRST')
}

/**
 * Read the lessons table back and decide whether THIS request's lesson exists.
 *
 * `client` is injected on purpose - callers pass either the route's own
 * adminClient or the recovery client built inside their outer catch. This
 * helper never constructs one, so it cannot fail on a missing env var at the
 * exact moment a booking is already in trouble.
 */
export async function verifyLessonCommitted(
  client: AdminClient,
  params: VerifyLessonCommittedParams,
): Promise<LessonCommitVerdict> {
  try {
    const meetingId = params.teamsMeetingId

    if (typeof meetingId === 'string' && meetingId.length > 0) {
      // -- MODE A: identify the row by its Teams meeting id ------------------
      // A Graph meeting is minted fresh per request, so the id is unique to
      // this attempt. A lessons row carrying it can only be the row THIS
      // request inserted - nobody else could have written that value. That
      // makes mode A exact in BOTH directions: presence proves committed,
      // absence proves not committed. No status filter, because a lesson that
      // was inserted and then immediately cancelled by someone else still
      // proves the insert committed.
      const { data, error } = await client
        .from('lessons')
        .select('id')
        .eq('teams_meeting_id', meetingId)
        .limit(2)

      if (error) {
        return { outcome: 'unresolved', reason: 'verify_failed', detail: error }
      }

      const rows = (data ?? []) as Array<{ id: string }>

      if (rows.length === 1) {
        return { outcome: 'committed', lessonId: rows[0].id }
      }
      if (rows.length === 0) {
        return { outcome: 'not_committed' }
      }
      // Two rows sharing a per-request meeting id must not happen. Something is
      // wrong that no automatic compensation should paper over, so no row is
      // picked and the caller escalates instead.
      return {
        outcome: 'unresolved',
        reason: 'ambiguous_row',
        detail: { matchedRows: rows.length, teamsMeetingId: meetingId },
      }
    }

    // -- MODE B: no meeting id, so match on the natural key --------------------
    //
    // MODE B NEVER RETURNS 'committed'. That asymmetry is deliberate and
    // load-bearing - do NOT "improve" it by adding a tie-breaker.
    //
    // Without a per-request meeting id there is nothing on the row that belongs
    // to THIS request. The natural key (teacher, student, training, start,
    // duration) is exactly what a concurrent duplicate submission would also
    // produce - a double click, a client retry after the lost response, an
    // admin booking the same slot at the same moment. created_at >=
    // requestStart narrows the window but cannot separate two requests inside
    // it.
    //
    // So a matching row is evidence that SOMEONE'S insert committed, never that
    // OURS did. Calling it ours would skip a refund that is genuinely owed and
    // double-deduct the student - the worse of the two errors, and the one
    // nobody notices until the hours run out. Absence is provable; presence is
    // not. Presence therefore returns 'unresolved' and a human decides.
    //
    // The cancelled family is excluded through the canonical CANCELLED_STATUSES
    // / toPostgrestInList pair rather than a hand-written list, so a future
    // cancellation status is excluded here automatically: a row cancelled
    // between the insert and this read describes a class that is no longer on
    // anyone's calendar, and must not stand in the way of a refund.
    const { data, error } = await client
      .from('lessons')
      .select('id')
      .eq('teacher_id', params.teacherId)
      .eq('student_id', params.studentId)
      .eq('training_id', params.trainingId)
      .eq('scheduled_at', params.scheduledAtIso)
      .eq('duration_minutes', params.durationMinutes)
      .is('teams_meeting_id', null)
      .gte('created_at', params.requestStartIso)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
      .limit(2)

    if (error) {
      return { outcome: 'unresolved', reason: 'verify_failed', detail: error }
    }

    const rows = (data ?? []) as Array<{ id: string }>

    if (rows.length === 0) {
      return { outcome: 'not_committed' }
    }

    return {
      outcome: 'unresolved',
      reason: 'ambiguous_row',
      detail: { matchedRows: rows.length },
    }
  } catch (thrown) {
    // A throw from the client (fetch failure, aborted request, a client that
    // could not even be built) tells us nothing at all about the row, which is
    // the definition of unresolved.
    return { outcome: 'unresolved', reason: 'verify_failed', detail: thrown }
  }
}
