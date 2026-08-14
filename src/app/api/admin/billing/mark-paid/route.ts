import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'

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
  // in for the historical record.
  const { data: invoiceForTeacherLookup } = await adminClient
    .from('invoices')
    .select('teacher_id, status')
    .eq('id', invoiceId)
    .maybeSingle()

  if (!invoiceForTeacherLookup) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }
  if (invoiceForTeacherLookup.status === 'paid') {
    // Already paid: never overwrite paid_at.
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
  // else marked it paid first.
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

  return NextResponse.json({ success: true })
}
