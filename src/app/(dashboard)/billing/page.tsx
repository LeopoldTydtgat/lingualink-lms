import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import BillingClient from './BillingClient'

export default async function BillingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  // Fetch billing info server-side via admin client — hourly_rate has a column-level REVOKE for anon/authenticated roles
  const { data: billingInfo } = await admin
    .from('profiles')
    .select('preferred_payment_type, paypal_email, iban, bic, tax_number, street_address, area_code, city, hourly_rate, currency, timezone')
    .eq('id', user.id)
    .single()

  return <BillingClient profile={profile} billingInfo={billingInfo ?? null} />
}
