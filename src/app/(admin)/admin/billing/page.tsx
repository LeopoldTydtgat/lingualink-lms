import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import BillingAdminClient from './BillingAdminClient'

export default async function AdminBillingPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, account_types')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  const isAdmin =
    profile.role === 'admin' ||
    (Array.isArray(profile.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) redirect('/dashboard')

  return <BillingAdminClient adminId={profile.id} />
}
