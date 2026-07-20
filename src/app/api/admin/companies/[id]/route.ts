import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    // --- 1. Verify admin ---
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // --- 2. Validate ---
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Company name is required.' }, { status: 400 })
    }

    // --- 3. Update ---
    const adminClient = createAdminClient()

    const { error: updateError } = await adminClient
      .from('companies')
      .update({
        name: body.name.trim(),
        type: body.type || null,
        contact_name: body.contact_name || null,
        contact_email: body.contact_email || null,
        contact_phone: body.contact_phone || null,
        country: body.country || null,
        billing_email: body.billing_email || null,
        cancellation_policy: body.cancellation_policy ?? '24hr',
        tags: body.tags ?? [],
        notes: body.notes || null,
        status: body.status ?? 'active',
      })
      .eq('id', id)

    if (updateError) {
      console.error('Company update error:', updateError)
      return NextResponse.json({ error: 'Failed to update company.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH company error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
