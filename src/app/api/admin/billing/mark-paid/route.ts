import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'

function formatMonthName(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

export async function PATCH(req: NextRequest) {
  // Auth + admin check via the shared canonical rule.
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { invoiceId } = await req.json()
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId required' }, { status: 400 })

  const adminClient = createAdminClient()

  // Recompute amount_eur BEFORE flipping status to 'paid'. The recompute helper
  // skips paid invoices to preserve historical figures, so once status='paid' is
  // set the amount is frozen. We need the latest billable-lesson total locked
  // in for both the historical record and the email body below.
  const { data: invoiceForTeacherLookup } = await adminClient
    .from('invoices')
    .select('teacher_id, status')
    .eq('id', invoiceId)
    .maybeSingle()

  if (!invoiceForTeacherLookup) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }
  if (invoiceForTeacherLookup.status === 'paid') {
    // Already paid: never overwrite paid_at or re-send the payment email.
    return NextResponse.json({ error: 'Invoice is already marked as paid' }, { status: 409 })
  }

  if (invoiceForTeacherLookup.teacher_id) {
    try {
      await recomputeInvoiceAmountsForTeacher(invoiceForTeacherLookup.teacher_id)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('TIMEZONE_MISSING:')) {
        return NextResponse.json(
          { error: 'TIMEZONE_MISSING', message: 'Cannot mark paid: the teacher has no timezone set. Set their timezone first.' },
          { status: 422 }
        )
      }
      throw err
    }
  }

  // .neq guards the race between the status check above and this write; the
  // .select confirms exactly which rows were touched — zero rows means someone
  // else marked it paid first, so we must not send a duplicate payment email.
  const { data: updatedRows, error } = await adminClient
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .neq('status', 'paid')
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json({ error: 'Invoice is already marked as paid' }, { status: 409 })
  }

  // Email runs only after a confirmed one-row update. Email failure must not
  // fail the request — the invoice is already paid at this point.
  try {
    const { data: invoice } = await adminClient
      .from('invoices')
      .select('teacher_id, billing_month, amount_eur')
      .eq('id', invoiceId)
      .single()

    if (invoice) {
      const { data: teacher } = await adminClient
        .from('profiles')
        .select('full_name, email, currency')
        .eq('id', invoice.teacher_id)
        .single()

      if (teacher?.email) {
        const paidSymbol = teacher.currency === 'USD' ? '$' : teacher.currency === 'GBP' ? '£' : '€'
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacher.email,
          subject: 'Lingualink Online - Your invoice has been paid',
          html: buildEmailTemplate({
            recipientName: teacher.full_name,
            recipientFallback: 'Teacher',
            subject: 'Lingualink Online - Your invoice has been paid',
            bodyHtml: `
              <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
                Your invoice for <strong>${formatMonthName(invoice.billing_month)}</strong> has been processed and payment of
                <strong>${paidSymbol}${Number(invoice.amount_eur ?? 0).toFixed(2)}</strong> will be transferred to your account within the agreed timeframe.
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
