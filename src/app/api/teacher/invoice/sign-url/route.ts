import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/teacher/invoice/sign-url
// Body: { invoiceId: string }
// Returns: { signedUrl }
//
// Generates a short-lived signed URL for an invoice PDF stored in the private
// `invoices` bucket. Signing must happen server-side: the browser client cannot
// read invoices that don't belong to it through RLS, but service-role signing
// bypasses RLS entirely, so we re-check ownership here.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

    const { invoiceId } = await request.json()
    if (!invoiceId || typeof invoiceId !== 'string') {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const adminClient = createAdminClient()
    const { data: invoice } = await adminClient
      .from('invoices')
      .select('id, teacher_id, file_path')
      .eq('id', invoiceId)
      .maybeSingle()

    if (!invoice || !invoice.file_path) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 })
    }

    // Owner can always view. The admin (role='admin') can view any teacher's
    // invoice. Billing surface — staff account_types deliberately do NOT pass.
    let allowed = invoice.teacher_id === user.id
    if (!allowed) {
      const { data: profile } = await adminClient
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      allowed = profile?.role === 'admin'
    }

    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await adminClient.storage
      .from('invoices')
      .createSignedUrl(invoice.file_path, 60)

    if (error || !data?.signedUrl) {
      console.error('[invoice/sign-url] createSignedUrl error:', error)
      return NextResponse.json({ error: 'Failed to generate signed URL.' }, { status: 500 })
    }

    return NextResponse.json({ signedUrl: data.signedUrl })
  } catch (err) {
    console.error('[invoice/sign-url] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
