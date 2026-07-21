import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

const PDF_MAGIC = '%PDF-'
const MAX_BYTES = 10 * 1024 * 1024
const TEMPLATE_PATH = 'invoice-template.pdf'

// POST /api/admin/invoice-template/upload
//
// The template is shared by every teacher. Without this guard, the previous
// client-side upload from BillingClient.tsx let any teacher overwrite the
// template by calling supabase.storage.upload directly.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const adminUser = await requireAdmin()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file.' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File must be under 10 MB.' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    return NextResponse.json({ error: 'Only PDF files are accepted.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { error: uploadErr } = await admin.storage
    .from('templates')
    .upload(TEMPLATE_PATH, buffer, { upsert: true, contentType: 'application/pdf' })

  if (uploadErr) {
    console.error('Template upload failed:', uploadErr)
    return NextResponse.json({ error: 'Upload failed.' }, { status: 500 })
  }

  const { error: settingsErr } = await admin.from('settings').upsert({
    key: 'invoice_template_path',
    value: TEMPLATE_PATH,
    updated_at: new Date().toISOString(),
  })

  if (settingsErr) {
    console.error('Settings upsert failed after template upload:', settingsErr)
    return NextResponse.json(
      { error: 'File uploaded but settings update failed.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, filePath: TEMPLATE_PATH })
}
