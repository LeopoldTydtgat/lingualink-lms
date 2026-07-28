import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isAdminProfile } from '@/lib/auth/requireAdmin'
import LibraryAdminClient from './LibraryAdminClient'

export default async function AdminLibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // A failed profiles read says nothing about the caller's role — throw rather
  // than treat it as "no profile" and bounce a valid admin. Only a confirmed
  // zero-rows result falls through to the fail-closed role denial below.
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[admin/library] profiles lookup failed:', error)
    throw new Error('Failed to load profile')
  }

  // Session is valid (getUser succeeded) — a missing profile row is a role
  // failure, not an authentication failure, so deny to /dashboard, not /login.
  if (!profile) redirect('/dashboard')

  if (!isAdminProfile(profile)) redirect('/dashboard')

  return <LibraryAdminClient adminId={profile.id} />
}
