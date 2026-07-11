'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// NEW303: resolve a support participant's display name + photo for a first-time
// sender that arrives via the list-level Realtime subscription (no existing
// conversation row to read from). Mirrors the participant lookup in page.tsx:
// teachers from profiles, students from students. Admin-gated — the service-role
// client is only reached after the caller is confirmed to be an admin.
export async function getSupportParticipant(
  participantId: string,
  participantType: 'teacher' | 'student'
): Promise<{ name: string; photoUrl: string | null } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const admin = createAdminClient()
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (callerProfile?.role !== 'admin') return { error: 'Unauthorized' }

  if (participantType === 'teacher') {
    const { data: profile } = await admin
      .from('profiles')
      .select('id, full_name, photo_url')
      .eq('id', participantId)
      .maybeSingle()
    return { name: profile?.full_name ?? 'Unknown', photoUrl: profile?.photo_url ?? null }
  }

  const { data: student } = await admin
    .from('students')
    .select('id, full_name, photo_url')
    .eq('id', participantId)
    .maybeSingle()
  return { name: student?.full_name ?? 'Unknown', photoUrl: student?.photo_url ?? null }
}
