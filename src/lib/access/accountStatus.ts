import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * NEW346 — the single source of truth for "may this account still be messaged".
 *
 * A messaging mutation (send or edit) requires the COUNTERPART account to be
 * `status = 'current'`. Read access is deliberately NOT gated by this: history must stay
 * readable, and the contact lists stay unfiltered. Only the composer gate and the
 * send/edit server actions consult this helper.
 *
 * Without it, a former student (or teacher) with an intact `training_teachers` row still
 * passes the NEW275 assignment gate in `trainingAssignment.ts`: the send succeeds and a
 * new-message email fires to an account `proxy.ts` will not let log in.
 *
 * DENY BY DEFAULT. There is no CHECK constraint on either `students.status` or
 * `profiles.status` (both are just `text DEFAULT 'current' NOT NULL`), so this helper
 * tests for `=== 'current'` and never for 'former'/'on_hold'. A missing row, an
 * unexpected value, and a query error all return false. Unlike `trainingAssignment.ts`
 * this helper does NOT throw — callers gate a mutation on a plain boolean, and a
 * verification failure must deny rather than surface as a distinct error.
 *
 * The caller injects the client, exactly as `trainingAssignment.ts` does:
 *   - 'student' -> `students`, requires createAdminClient() (RLS blocks the teacher role)
 *   - 'teacher' -> `profiles`, has GRANT SELECT(status) to authenticated, so the regular
 *     server client also works
 * A receiver_type of 'admin' maps to 'teacher': admins live in `profiles` too.
 */

export type CounterpartType = 'student' | 'teacher'

/**
 * True only when the counterpart row exists AND its status is exactly 'current'.
 * Never throws; every failure mode returns false.
 *
 * `id` is the id stored on the message row: `students.id` for a student (NOT
 * `auth_user_id` — messages use the table PK, see the student actions' sender_id) and
 * `profiles.id` for a teacher/admin.
 */
export async function isCounterpartCurrent(
  db: SupabaseClient,
  id: string,
  type: CounterpartType,
): Promise<boolean> {
  const table = type === 'student' ? 'students' : 'profiles'

  const { data, error } = await db
    .from(table)
    .select('status')
    .eq('id', id)
    .maybeSingle()

  if (error) return false
  if (!data) return false
  return data.status === 'current'
}

/**
 * Shown to the sender when the counterpart is no longer current. Mirrors
 * EDIT_WINDOW_ERROR in `src/lib/messages/editWindow.ts`: one exported constant so the
 * three server actions and any client that wants to surface it verbatim cannot drift.
 */
export const ACCOUNT_INACTIVE_ERROR =
  'This account is no longer active. You can view the conversation but cannot send new messages.'
