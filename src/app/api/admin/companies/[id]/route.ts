import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { UpdateCompanySchema } from '@/lib/validation/schemas'
import { z } from 'zod'
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
    // A non-uuid path segment can never name a row, and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Invalid company id.' }, { status: 400 })
    }

    // companies carries CHECK constraints on type, status and
    // cancellation_policy; the schema enums mirror them, so a bad value is a 400
    // here rather than a 23514 surfacing as an opaque 500. Those three are NOT
    // nullable: an explicit null is now rejected instead of being silently
    // coalesced to '24hr' / 'active' as the old `??` code did. Every field is
    // optional, so a partial PATCH such as { status } stays legal.
    const parsed = UpdateCompanySchema.safeParse(body)
    if (!parsed.success) {
      console.error('Company update validation failed:', parsed.error.issues)
      return NextResponse.json({ error: 'Invalid request data.' }, { status: 400 })
    }
    const fields = parsed.data

    // --- 3. Update ---
    // Write ONLY the fields present in the request body: absent → untouched,
    // present → written with the same per-field transform as before (empty
    // string still clears a text field). Defaulting absent fields would wipe
    // the rest of the row on a partial PATCH. Zod omits absent keys from the
    // parsed result entirely, so `!== undefined` is exactly the old
    // `'x' in body` presence test. name arrives already trimmed.
    const updatePayload: Record<string, unknown> = {}
    if (fields.name !== undefined) updatePayload.name = fields.name
    if (fields.type !== undefined) updatePayload.type = fields.type
    if (fields.contact_name !== undefined) updatePayload.contact_name = fields.contact_name || null
    if (fields.contact_email !== undefined) updatePayload.contact_email = fields.contact_email || null
    if (fields.contact_phone !== undefined) updatePayload.contact_phone = fields.contact_phone || null
    if (fields.country !== undefined) updatePayload.country = fields.country || null
    if (fields.billing_email !== undefined) updatePayload.billing_email = fields.billing_email || null
    if (fields.cancellation_policy !== undefined) updatePayload.cancellation_policy = fields.cancellation_policy
    if (fields.tags !== undefined) updatePayload.tags = fields.tags
    if (fields.notes !== undefined) updatePayload.notes = fields.notes || null
    if (fields.status !== undefined) updatePayload.status = fields.status

    // Nothing recognised in the body → nothing to write. PostgREST rejects an
    // empty update, so no-op instead. (companies has no updated_at column.)
    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ success: true })
    }

    const adminClient = createAdminClient()

    const { data: updated, error: updateError } = await adminClient
      .from('companies')
      .update(updatePayload)
      .eq('id', id)
      .select('id')

    if (updateError) {
      console.error('Company update error:', updateError)
      return NextResponse.json({ error: 'Failed to update company.' }, { status: 500 })
    }

    // PostgREST does not error on a zero-row UPDATE. Without this check the
    // route answered 200 { success: true } for a company id that matched
    // nothing, so the admin UI reported a save that wrote no row.
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'Company not found.' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH company error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
