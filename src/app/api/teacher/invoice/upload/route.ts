import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const PDF_MAGIC = '%PDF-'
const MAX_BYTES = 5 * 1024 * 1024

// POST /api/teacher/invoice/upload
//
// Replaces the previous client-side direct call to supabase.storage.upload.
// Doing the upload in the browser meant all MIME, size, ownership, and
// upload-window checks were JavaScript and could be skipped by a direct
// HTTP client to Supabase Storage. This route enforces them server-side.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const form = await req.formData()
  const file = form.get('file')
  const invoiceId = form.get('invoiceId')

  if (!(file instanceof File) || typeof invoiceId !== 'string') {
    return NextResponse.json({ error: 'Missing file or invoiceId.' }, { status: 400 })
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File must be under 5 MB.' }, { status: 400 })
  }

  // Magic-byte check against the actual buffer. The browser-supplied MIME
  // and filename are attacker-controlled and not enough on their own.
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    return NextResponse.json({ error: 'Only PDF files are accepted.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: invoice, error: invErr } = await admin
    .from('invoices')
    .select('id, teacher_id, billing_month')
    .eq('id', invoiceId)
    .maybeSingle()

  if (invErr || !invoice) {
    return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 })
  }
  if (invoice.teacher_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Upload window: 1st–10th of the month following the billing period.
  const now = new Date()
  if (now.getUTCDate() > 10) {
    return NextResponse.json(
      { error: 'Invoice upload is only allowed between the 1st and 10th of the month following the billing period.' },
      { status: 403 }
    )
  }

  const [bYear, bMonth] = (invoice.billing_month as string).split('-').map(Number)
  const billingMonthStart = Date.UTC(bYear, bMonth - 1, 1)
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  if (billingMonthStart >= currentMonthStart) {
    return NextResponse.json(
      { error: 'You can only upload invoices for past months.' },
      { status: 403 }
    )
  }

  const filePath = `${invoice.teacher_id}/${(invoice.billing_month as string).slice(0, 7)}.pdf`

  const { error: uploadErr } = await admin.storage
    .from('invoices')
    .upload(filePath, buffer, { upsert: true, contentType: 'application/pdf' })

  if (uploadErr) {
    console.error('Invoice storage upload failed:', uploadErr)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }

  const { error: updErr } = await admin
    .from('invoices')
    .update({ file_path: filePath, uploaded_at: new Date().toISOString() })
    .eq('id', invoice.id)

  if (updErr) {
    console.error('Invoice DB update failed after storage upload:', updErr)
    return NextResponse.json(
      { error: 'File uploaded but record update failed. Please contact admin.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, filePath })
}
