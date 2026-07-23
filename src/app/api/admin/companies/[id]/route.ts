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
    // name is only required when the request tries to set it — a partial
    // PATCH (e.g. { status }) must not demand (or touch) the name.
    if ('name' in body && !body.name?.trim()) {
      return NextResponse.json({ error: 'Company name is required.' }, { status: 400 })
    }

    // --- 3. Update ---
    // Write ONLY the fields present in the request body: absent → untouched,
    // present → written with the same per-field transform as before (empty
    // string still clears a text field). Defaulting absent fields would wipe
    // the rest of the row on a partial PATCH.
    const updatePayload: Record<string, unknown> = {}
    if ('name' in body) updatePayload.name = body.name.trim()
    if ('type' in body) updatePayload.type = body.type || null
    if ('contact_name' in body) updatePayload.contact_name = body.contact_name || null
    if ('contact_email' in body) updatePayload.contact_email = body.contact_email || null
    if ('contact_phone' in body) updatePayload.contact_phone = body.contact_phone || null
    if ('country' in body) updatePayload.country = body.country || null
    if ('billing_email' in body) updatePayload.billing_email = body.billing_email || null
    if ('cancellation_policy' in body) updatePayload.cancellation_policy = body.cancellation_policy ?? '24hr'
    if ('tags' in body) updatePayload.tags = body.tags ?? []
    if ('notes' in body) updatePayload.notes = body.notes || null
    if ('status' in body) updatePayload.status = body.status ?? 'active'

    // Nothing recognised in the body → nothing to write. PostgREST rejects an
    // empty update, so no-op instead. (companies has no updated_at column.)
    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ success: true })
    }

    const adminClient = createAdminClient()

    const { error: updateError } = await adminClient
      .from('companies')
      .update(updatePayload)
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
