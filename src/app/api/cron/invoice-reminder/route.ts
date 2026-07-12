import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'
import { verifyCronAuth } from '@/lib/cron-auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const now = new Date()
  if (now.getUTCDate() !== 1) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  // Idempotency guard — Vercel Cron retries on timeout would otherwise re-send
  // every email to every teacher. The cron_runs table has a UNIQUE constraint
  // on (cron_name, run_date) so the second insert is silently dropped, and the
  // empty `data` array tells us we've already run today.
  const runDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  const { data: runRows, error: runErr } = await supabase
    .from('cron_runs')
    .upsert(
      { cron_name: 'invoice-reminder', run_date: runDate },
      { onConflict: 'cron_name,run_date', ignoreDuplicates: true }
    )
    .select()

  if (runErr) {
    console.error('cron_runs guard failed:', runErr)
    return NextResponse.json({ error: 'Idempotency check failed' }, { status: 500 })
  }
  if (!runRows || runRows.length === 0) {
    return NextResponse.json({ ok: true, alreadyRanToday: true })
  }

  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const monthYear = `${MONTHS[prevMonth.getUTCMonth()]} ${prevMonth.getUTCFullYear()}`

  const { data: teachers, error } = await supabase
    .from('profiles')
    .select('full_name, email')
    .contains('account_types', ['teacher'])
    .neq('status', 'former')

  if (error) {
    console.error('Error fetching teachers for invoice reminder:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let sent = 0

  for (const teacher of teachers ?? []) {
    try {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: `Lingualink Online - Please upload your invoice for ${monthYear}`,
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject: `Please upload your invoice for ${monthYear}`,
          bodyHtml: `
            <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
              It's the start of a new month — please remember to upload your invoice for <strong>${monthYear}</strong> via the teacher portal.
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
              Invoices should be submitted between the <strong>1st and 10th of the month</strong>. Invoices received after the 10th will be processed the following month.
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
              Please log in to your portal to upload your invoice.
            </p>
            <a
              href="${process.env.NEXT_PUBLIC_TEACHER_URL}/billing"
              style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
            >
              Upload My Invoice
            </a>
          `,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })

      sent++
    } catch (err) {
      console.error(`Failed to send invoice reminder to ${teacher.email}:`, err)
    }
  }

  await supabase
    .from('cron_runs')
    .update({ completed_at: new Date().toISOString() })
    .eq('cron_name', 'invoice-reminder')
    .eq('run_date', runDate)

  return NextResponse.json({ ok: true, sent })
}
