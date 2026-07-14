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
 * NEW347 — true only when EVERY account row belonging to this auth uuid is exactly
 * 'current'. Never throws; every failure mode returns false.
 *
 * Separate from `isCounterpartCurrent` because it keys on a different identifier:
 * this helper takes the AUTH uuid (`auth.users.id`, i.e. `user.id` from
 * `supabase.auth.getUser()`), whereas `isCounterpartCurrent` takes the TABLE PK stored
 * on the message row. The two coincide for teachers/admins (`profiles.id` IS the auth
 * uuid) but NOT for students: `students.auth_user_id` is the indirection, so passing an
 * auth uuid to `isCounterpartCurrent` would match zero student rows and deny every
 * student. Keep the two helpers distinct — do not merge them.
 *
 * BOTH tables are ALWAYS checked, and the lookups never short-circuit. One auth uuid can
 * hold a `profiles` row AND a `students` row at the same time (live example, logged as
 * NEW110: auth 03abd97e has students.status 'current' with profiles.status 'former'), so
 * ROW PRESENCE IS NOT A ROLE SIGNAL — a profiles hit is NOT proof the sender is a
 * teacher, and returning on it would both deny that live student support access and, in
 * the mirror case (profiles 'current' + students 'former'), let a former student through.
 *
 * Requires the service-role client (createAdminClient()): RLS blocks `students` reads
 * under the teacher role, so a regular server client would deny students spuriously.
 * The caller injects it, same contract as `isCounterpartCurrent`.
 *
 * DENY BY DEFAULT: neither status column has a CHECK constraint, so this tests
 * `=== 'current'` and never `!= 'former'`. An error on EITHER query, no row in either
 * table, an unexpected value, and any single 'former'/'on_hold' row all return false.
 */
export async function isSenderCurrent(
  db: SupabaseClient,
  authUserId: string,
): Promise<boolean> {
  const [profileResult, studentResult] = await Promise.all([
    db.from('profiles').select('status').eq('id', authUserId).maybeSingle(),
    db.from('students').select('status').eq('auth_user_id', authUserId).maybeSingle(),
  ])

  if (profileResult.error || studentResult.error) return false

  const rows = [profileResult.data, studentResult.data].filter(
    (row): row is { status: string } => row !== null,
  )

  if (rows.length === 0) return false
  return rows.every(row => row.status === 'current')
}

/**
 * Shown to the sender when the counterpart is no longer current. Mirrors
 * EDIT_WINDOW_ERROR in `src/lib/messages/editWindow.ts`: one exported constant so the
 * three server actions and any client that wants to surface it verbatim cannot drift.
 */
export const ACCOUNT_INACTIVE_ERROR =
  'This account is no longer active. You can view the conversation but cannot send new messages.'
