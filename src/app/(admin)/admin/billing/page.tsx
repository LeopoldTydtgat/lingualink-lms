import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import BillingAdminClient from './BillingAdminClient'
import { recomputeInvoiceAmountsForAllTeachers } from '@/lib/billing/recomputeAmounts'

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

  // Refresh the cached amount_eur for every teacher so the page header total
  // always matches the recomputed-from-lessons figure shown in expanded detail.
  await recomputeInvoiceAmountsForAllTeachers()

  return <BillingAdminClient adminId={profile.id} />
}
