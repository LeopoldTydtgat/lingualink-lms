import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isAdminProfile } from '@/lib/auth/requireAdmin'
import BillingAdminClient from './BillingAdminClient'
import { recomputeInvoiceAmountsForAllTeachers } from '@/lib/billing/recomputeAmounts'
import { getExportTimezone } from '@/lib/exportTime'

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  // Stat-card deep link (/admin/billing?filter=invoices_review) opens the Teacher
  // Invoices tab pre-filtered to 'uploaded' — the exact status the card counts.
  // Anything else leaves both at the client's own defaults.
  const { filter } = await searchParams
  const invoicesReview = filter === 'invoices_review'

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

  // Refresh the cached amount_eur for every teacher so the page header total
  // always matches the recomputed-from-lessons figure shown in expanded detail.
  await recomputeInvoiceAmountsForAllTeachers()

  // Settings-driven export timezone, resolved server-side and threaded to the
  // client so its Student Billing CSV export renders instants in the same zone
  // as the server-route exports. getExportTimezone is server-only.
  const exportTz = await getExportTimezone()

  return (
    <BillingAdminClient
      adminId={profile.id}
      exportTz={exportTz}
      initialTab={invoicesReview ? 'teacher_invoices' : undefined}
      initialInvoiceStatus={invoicesReview ? 'uploaded' : undefined}
    />
  )
}
