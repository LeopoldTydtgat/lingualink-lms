import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isAdminProfile } from '@/lib/auth/requireAdmin'
import BillingAdminClient from './BillingAdminClient'
import { recomputeInvoiceAmountsForAllTeachers } from '@/lib/billing/recomputeAmounts'
import { getExportTimezone } from '@/lib/exportTime'
import { getMonthToDateRange } from '@/lib/dates/dateRangePresets'

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

  // A query error and a genuinely missing row are different failures: the first is
  // transient and must surface, the second is a real "no profile" state. Discarding
  // the error made both look like null and bounced the user to /login.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, full_name, role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[admin/billing] profiles lookup failed:', profileError)
    throw new Error('Failed to load profile')
  }
  if (!profile) redirect('/login')

  if (!isAdminProfile(profile)) redirect('/dashboard')

  // Refresh the cached amount_eur for every teacher so the page header total
  // always matches the recomputed-from-lessons figure shown in expanded detail.
  await recomputeInvoiceAmountsForAllTeachers()

  // Settings-driven export timezone, resolved server-side and threaded to the
  // client so its Student Billing CSV export renders instants in the same zone
  // as the server-route exports. getExportTimezone is server-only.
  const exportTz = await getExportTimezone()

  // The range both date-filtered tabs (Student Billing, Company Billing) LAND on: the
  // 1st of the current calendar month through today. Computed HERE, per landing, and
  // deliberately never stored — a month-to-date range written into sessionStorage would
  // name the wrong month the first time a session crossed a month boundary, which is
  // exactly why the date ranges left the client's stored record.
  //
  // Resolved in exportTz rather than in an admin profile timezone, because this page has
  // no profile timezone anywhere: both DateRangeFilter instances take tz={exportTz} and
  // resolveDayBounds scopes both Apply queries in exportTz, so a seed in any other zone
  // would name days those queries do not fetch. Unlike the Classes list there is no
  // timezone-less arm to guard: getExportTimezone always returns a validated IANA zone
  // (falling back to EXPORT_TZ_FALLBACK), so "which day is today" always has an answer.
  const monthToDate = getMonthToDateRange(new Date(), exportTz)

  return (
    <BillingAdminClient
      adminId={profile.id}
      exportTz={exportTz}
      // Seeds the two tabs' From/To inputs only — neither tab fetches on mount, so the
      // admin still presses Apply to load anything.
      defaultDateFrom={monthToDate.from}
      defaultDateTo={monthToDate.to}
      initialTab={invoicesReview ? 'teacher_invoices' : undefined}
      initialInvoiceStatus={invoicesReview ? 'uploaded' : undefined}
    />
  )
}
