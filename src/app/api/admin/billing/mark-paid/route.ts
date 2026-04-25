import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Admin role check
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { invoiceId } = await req.json()
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId required' }, { status: 400 })

  const { error } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    const adminClient = createAdminClient()

    const { data: invoice } = await adminClient
      .from('invoices')
      .select('teacher_id, month, amount')
      .eq('id', invoiceId)
      .single()

    if (invoice) {
      const { data: teacher } = await adminClient
        .from('profiles')
        .select('full_name, email')
        .eq('id', invoice.teacher_id)
        .single()

      if (teacher?.email) {
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacher.email,
          subject: 'Lingualink Online — Your invoice has been paid',
          html: buildEmailTemplate({
            recipientName: teacher.full_name,
            subject: 'Lingualink Online — Your invoice has been paid',
            bodyHtml: `
              <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
                Your invoice for <strong>${invoice.month}</strong> has been processed and payment of
                <strong>€${invoice.amount}</strong> will be transferred to your account within the agreed timeframe.
              </p>
            `,
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
      }
    }
  } catch (err) {
    console.error('Failed to send invoice paid email:', err)
  }

  return NextResponse.json({ success: true })
}
