import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isAdminProfile } from '@/lib/auth/requireAdmin'
import LibraryAdminClient from './LibraryAdminClient'

export default async function AdminLibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, account_types')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  if (!isAdminProfile(profile)) redirect('/dashboard')

  return <LibraryAdminClient adminId={profile.id} />
}
