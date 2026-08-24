import { createAdminClient } from '@/lib/supabase/admin'

/**
 * BOOK-AUDIT 1 - surface a failed hours refund/unwind in the admin portal.
 *
 * The booking routes already log CRITICAL when a money RPC that was supposed to
 * give a student's hours back comes back failed. A Vercel log line is invisible
 * to the people who actually reconcile hours, so every one of those sites now
 * also raises an admin_tasks row.
 *
 * Two properties this helper must never lose:
 *
 *  - It CANNOT throw. Every call site is already inside a failure handler (two
 *    of them inside a catch block); a throw here would replace a handled
 *    booking failure with an unhandled one, and in the outer-catch sites it
 *    would abort the 500 response the student is waiting for. The entire body
 *    is therefore wrapped, and every failure degrades to console.error - which
 *    is exactly the behaviour that existed before this helper.
 *
 *  - It builds its OWN service-role client. It deliberately does not accept one
 *    as a parameter: at the outer-catch call sites the route's adminClient is
 *    scoped to a try block that may never have reached its construction, so
 *    there is no client to hand in.
 */

// Longest rendering of errorDetail that is written into notes. Long enough for
// a PostgrestError (message + details + hint + code), short enough that a
// runaway error payload cannot bloat the task row.
const MAX_ERROR_CHARS = 500

/**
 * Best-effort plain-text rendering of an unknown error value.
 *
 * String() alone is not used on objects: a Supabase PostgrestError stringifies
 * to "[object Object]", which would drop the very detail this task exists to
 * carry. JSON first, String() as the fallback for anything JSON cannot handle
 * (circular refs, BigInt, a bare undefined).
 */
function renderErrorDetail(errorDetail: unknown): string {
  let rendered: string
  try {
    if (errorDetail instanceof Error) {
      rendered = `${errorDetail.name}: ${errorDetail.message}`
    } else if (typeof errorDetail === 'object' && errorDetail !== null) {
      rendered = JSON.stringify(errorDetail) ?? String(errorDetail)
    } else {
      rendered = String(errorDetail)
    }
  } catch {
    // JSON.stringify throws on circular structures and BigInt.
    try {
      rendered = String(errorDetail)
    } catch {
      rendered = '(unrenderable error value)'
    }
  }
  return rendered.length > MAX_ERROR_CHARS
    ? `${rendered.slice(0, MAX_ERROR_CHARS)}... (truncated)`
    : rendered
}

export async function raiseReconciliationTask(input: {
  studentId: string | null
  trainingId: string | null
  lessonId: string | null
  hours: number | null
  context: string
  errorDetail: unknown
}): Promise<void> {
  try {
    const client = createAdminClient()

    // Resolve the admin to own the task. assigned_to and created_by are both
    // NOT NULL and both FK profiles.id, so a task cannot be raised without one.
    // Exactly one admin profile exists today, but the id is never hardcoded:
    // if that ever stops being true the lookup below stops inserting rather
    // than guessing which admin should own a money-path failure.
    const { data: admins, error: adminError } = await client
      .from('profiles')
      .select('id')
      .eq('role', 'admin')

    if (adminError) {
      console.error('raiseReconciliationTask: admin lookup failed - no task raised.', {
        context: input.context,
        error: adminError,
      })
      return
    }

    if (!Array.isArray(admins) || admins.length !== 1) {
      console.error('raiseReconciliationTask: expected exactly one admin profile - no task raised.', {
        context: input.context,
        admin_count: Array.isArray(admins) ? admins.length : null,
      })
      return
    }

    const adminId = admins[0]?.id
    if (typeof adminId !== 'string' || adminId.length === 0) {
      console.error('raiseReconciliationTask: admin profile has no usable id - no task raised.', {
        context: input.context,
      })
      return
    }

    // Normalised ONCE, then used for both link columns and the notes. A single
    // source is what keeps the two columns consistent: an empty string is
    // falsy but not nullish, so testing it two different ways would write
    // linked_entity_type null alongside linked_entity_id '' - which a uuid
    // column rejects (22P02) and the whole task would be lost.
    const studentId =
      typeof input.studentId === 'string' && input.studentId.length > 0 ? input.studentId : null

    // Plain text, not JSON: this is the notes column an admin reads on the task.
    // Every field is labelled rather than positional, because the tasks LIST
    // renders notes in a plain <p> that collapses these newlines into one run-on
    // line; the newlines only survive in the task edit form's textarea. Labels
    // keep it readable either way.
    const notes = [
      'Raised automatically by the booking API - a student hours reversal did not complete.',
      '',
      `Context: ${input.context}`,
      `Student ID: ${studentId ?? 'unknown'}`,
      `Training ID: ${input.trainingId ?? 'unknown'}`,
      `Lesson ID: ${input.lessonId ?? 'none'}`,
      `Hours: ${input.hours ?? 'unknown'}`,
      `Error: ${renderErrorDetail(input.errorDetail)}`,
    ].join('\n')

    // linked_entity_type 'student' pairs with linked_entity_id = students.id
    // (the id space the tasks list resolves student names from). With no
    // student id there is nothing to link, so BOTH columns go null - a type
    // with no id would render as an unresolvable link in the admin portal.
    const { error: insertError } = await client.from('admin_tasks').insert({
      title: 'Reconcile student hours - booking failure',
      linked_entity_type: studentId ? 'student' : null,
      linked_entity_id: studentId,
      assigned_to: adminId,
      created_by: adminId,
      due_date: null,
      priority: 'high',
      follow_up_reason: 'payment',
      status: 'open',
      notes,
    })

    if (insertError) {
      console.error('raiseReconciliationTask: admin_tasks insert failed - no task raised.', {
        context: input.context,
        student_id: input.studentId,
        training_id: input.trainingId,
        error: insertError,
      })
    }
  } catch (err) {
    // Nothing above may reach the caller. The CRITICAL log at the call site is
    // still the record of the underlying money failure.
    console.error('raiseReconciliationTask: threw while raising the task - no task raised.', {
      context: input?.context,
      error: err,
    })
  }
}
