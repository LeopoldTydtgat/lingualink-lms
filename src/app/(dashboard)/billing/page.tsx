import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import BillingClient from './BillingClient'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'
import { getMonthKeyInTz } from '@/lib/billing/monthRange'

type LessonRow = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  students: { full_name: string } | { full_name: string }[] | null
}

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

  if (!billingInfo?.timezone) {
    return (
      <div className="p-8 text-gray-500">Your account is missing a timezone. Please contact admin to set it before billing can be displayed.</div>
    )
  }
  const tz = billingInfo.timezone
  const currentMonthDate = getMonthKeyInTz(new Date(), tz)

  // ensureCurrentInvoice — moved here from BillingClient. Creates a 'pending'
  // row for the current month if none exists, so the recompute below has a
  // target to write the freshly-summed amount into.
  const { data: existingCurrent } = await admin
    .from('invoices')
    .select('id')
    .eq('teacher_id', user.id)
    .eq('billing_month', currentMonthDate)
    .maybeSingle()

  if (!existingCurrent) {
    const nowDate = new Date()
    let exhausted = true
    for (let attempt = 0; attempt < 5; attempt++) {
      const refNumber = `INV-${nowDate.getFullYear()}${String(nowDate.getMonth() + 1).padStart(2, '0')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
      const { error } = await admin.from('invoices').insert({
        teacher_id: user.id,
        billing_month: currentMonthDate,
        status: 'pending',
        reference_number: refNumber,
      })
      if (!error) { exhausted = false; break }
      if (error.code === '23505') {
        const { data: nowExists } = await admin
          .from('invoices')
          .select('id')
          .eq('teacher_id', user.id)
          .eq('billing_month', currentMonthDate)
          .maybeSingle()
        if (nowExists) { exhausted = false; break }
        // reference_number collision — retry with fresh suffix
      } else {
        console.error('[billing] invoice insert failed', error)
        exhausted = false
        break
      }
    }
    if (exhausted) {
      console.error('[billing] invoice insert exhausted 5 reference-number collisions; current-month row not created', { teacher_id: user.id, billing_month: currentMonthDate })
    }
  }

  // Sync amount_eur for this teacher so the page header matches expanded detail.
  await recomputeInvoiceAmountsForTeacher(user.id)

  const { data: invoices } = await admin
    .from('invoices')
    .select('*')
    .eq('teacher_id', user.id)
    .order('billing_month', { ascending: false })

  // Lessons fuel the expanded-detail breakdown. Fetched here so the client
  // doesn't need a separate effect after the loadData removal.
  const { data: lessons } = await admin
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, status, cancelled_at, students(full_name)')
    .eq('teacher_id', user.id)
    .in('status', ['completed', 'student_no_show', 'cancelled', 'cancelled_by_student', 'cancelled_by_teacher'])
    .order('scheduled_at', { ascending: true })

  const lessonsByMonth: Record<string, LessonRow[]> = {}
  for (const lesson of (lessons as LessonRow[] | null) || []) {
    const key = getMonthKeyInTz(new Date(lesson.scheduled_at), tz)
    if (!lessonsByMonth[key]) lessonsByMonth[key] = []
    lessonsByMonth[key].push(lesson)
  }

  const { data: settingsData } = await admin
    .from('settings')
    .select('value')
    .eq('key', 'invoice_template_path')
    .maybeSingle()

  const templateUrl = settingsData?.value
    ? admin.storage.from('templates').getPublicUrl(settingsData.value).data.publicUrl
    : null

  return (
    <BillingClient
      profile={profile}
      billingInfo={billingInfo ?? null}
      initialInvoices={invoices ?? []}
      initialLessonsByMonth={lessonsByMonth}
      initialTemplateUrl={templateUrl}
      currentMonthDate={currentMonthDate}
    />
  )
}
