'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Stamp the current student's What's New "seen" marker to now. Sibling of
// (dashboard)/actions/whatsNewSeen.ts.
//
// IDENTITY RULE: auth.uid() = students.auth_user_id, NOT students.id. The write
// below keys on auth_user_id — the students table PK never appears here.
//
// The students.whats_new_seen_at column has no authenticated write grant by
// design (students carries column-level access control), so the update must go
// through the service-role admin client. Identity is still established from the
// RLS-scoped session client — the admin client only performs the write for that
// auth user id.
//
// FAILURE MODEL: supabase-js RESOLVES with { error } on a PostgREST failure — it
// does not throw. Seen-marking is best-effort (the sole caller fires it with
// .catch(() => {}) and the badge self-corrects on the next open), so a failure is
// logged for server-side visibility but deliberately NOT rethrown.
export async function markStudentWhatsNewSeen(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const admin = createAdminClient()
  const { error } = await admin
    .from('students')
    .update({ whats_new_seen_at: new Date().toISOString() })
    .eq('auth_user_id', user.id)

  if (error) {
    console.error('[markStudentWhatsNewSeen] seen-stamp update failed:', error)
  }
}
