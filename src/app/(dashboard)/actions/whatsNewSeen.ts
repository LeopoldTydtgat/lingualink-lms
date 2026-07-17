'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Stamp the current teacher's What's New "seen" marker to now. The
// profiles.whats_new_seen_at column has no authenticated write grant by design
// (profiles carries column-level REVOKEs), so the update must go through the
// service-role admin client. Identity is still established from the RLS-scoped
// session client — the admin client only performs the write for that user id.
export async function markWhatsNewSeen(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const admin = createAdminClient()
  await admin
    .from('profiles')
    .update({ whats_new_seen_at: new Date().toISOString() })
    .eq('id', user.id)
}
