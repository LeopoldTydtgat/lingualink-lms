import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  if (now.getUTCDate() !== 1) {
    return NextResponse.json({ ok: true, skipped: true })
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
        subject: `Lingualink Online — Please upload your invoice for ${monthYear}`,
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
              href="${process.env.NEXT_PUBLIC_SITE_URL}/billing"
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

  return NextResponse.json({ ok: true, sent })
}
