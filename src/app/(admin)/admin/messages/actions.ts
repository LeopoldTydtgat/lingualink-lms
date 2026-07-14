'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function assertAdmin() {
  // RLS-bound client — role lookup must run as the user, not via service role.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (profile?.account_types ?? []).includes('school_admin')
  if (!isAdmin) throw new Error('Unauthorized')
}

export async function getAdminThreadMessages(teacherSideId: string, studentId: string) {
  await assertAdmin()

  const adminDb = createAdminClient()

  const { data } = await adminDb
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, admin_read_at, created_at')
    .or(
      `and(sender_id.eq.${teacherSideId},receiver_id.eq.${studentId}),` +
      `and(sender_id.eq.${studentId},receiver_id.eq.${teacherSideId}),` +
      `and(sender_type.eq.admin,receiver_id.eq.${studentId}),` +
      `and(sender_type.eq.admin,receiver_id.eq.${teacherSideId})`
    )
    .order('created_at', { ascending: true })

  return data ?? []
}

export async function getUnreadAdminMessagesCount() {
  await assertAdmin()

  const adminDb = createAdminClient()

  // Mirrors src/app/(admin)/layout.tsx's nav badge query exactly — student-involving
  // conversations only, admin_read_at is null. Must run via admin client: the browser
  // role has zero column grants on admin_read_at, so Realtime payloads never carry it.
  const { count } = await adminDb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .is('admin_read_at', null)
    .or('sender_type.eq.student,receiver_type.eq.student')

  return count ?? 0
}

export async function markAdminThreadRead(teacherSideId: string, studentId: string) {
  await assertAdmin()

  const adminDb = createAdminClient()

  await adminDb
    .from('messages')
    .update({ admin_read_at: new Date().toISOString() })
    .or(
      `and(sender_id.eq.${teacherSideId},receiver_id.eq.${studentId}),` +
      `and(sender_id.eq.${studentId},receiver_id.eq.${teacherSideId})`
    )
    .is('admin_read_at', null)
}
