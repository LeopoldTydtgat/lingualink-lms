import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { HoursAdjustmentSchema } from '@/lib/validation/schemas'
import { checkAdminHoursMutationLimit } from '@/lib/rateLimit'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: studentId } = await params

    // ── 1. Validate the studentId URL param is a UUID ────────────────────────
    const uuidResult = z.string().uuid().safeParse(studentId)
    if (!uuidResult.success) {
      return NextResponse.json({ error: 'Invalid student ID.' }, { status: 400 })
    }

    const body = await req.json()

    // ── 2. Validate the request body ─────────────────────────────────────────
    const parsed = HoursAdjustmentSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const data = parsed.data

    // Business rule: notes are required when removing hours
    if (data.action === 'remove' && !data.notes?.trim()) {
      return NextResponse.json(
        { error: 'Notes are required when removing hours.' },
        { status: 400 }
      )
    }

    // ── 3. Verify admin ───────────────────────────────────────────────────────
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('account_types, role, id')
      .eq('id', user.id)
      .single()

    if (!adminProfile) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const isAdmin =
      adminProfile.role === 'admin' ||
      (adminProfile.account_types ?? []).includes('school_admin')

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Per-admin mutation limit — 50/hour. Caps the blast radius of a
    // compromised admin session that scripts mass hour changes.
    const limit = await checkAdminHoursMutationLimit(user.id)
    if (limit.blocked) {
      return NextResponse.json(
        { error: 'Too many hour adjustments. Please try again later.', retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429 },
      )
    }

    // ── 4. Apply the adjustment atomically ────────────────────────────────────
    // Locked balance read + total_hours/hours_consumed write + hours_log insert,
    // all in one transaction. Replaces the former read-modify-write, which raced
    // concurrent writers and could silently drop the ledger row on insert failure.
    const adminClient = createAdminClient()

    // Defense-in-depth ownership guard: reject a training_id that isn't this
    // student's before mutating. adjust_hours_atomic also scopes its locked read
    // by (id, student_id), but the route enforces its own authorization invariant
    // here too (mirrors the profile-edit route). Ownership 404 only — no balance
    // read; the locked balance read still happens inside the RPC, so no race.
    const { data: owned, error: ownErr } = await adminClient
      .from('trainings')
      .select('id')
      .eq('id', data.training_id)
      .eq('student_id', studentId)
      .maybeSingle()

    if (ownErr || !owned) {
      return NextResponse.json({ error: 'Training record not found.' }, { status: 404 })
    }

    const { data: newBalance, error: rpcError } = await adminClient.rpc('adjust_hours_atomic', {
      p_training_id: data.training_id,
      p_student_id: studentId,
      p_action: data.action,
      p_amount: data.amount,
      p_log_type: data.action === 'add' ? 'add' : 'deduct',
      p_created_by: adminProfile.id,
      p_invoice_reference: data.invoice_reference ?? null,
      p_notes: data.notes ?? null,
    })

    if (rpcError) {
      const msg = (rpcError.message || '').toLowerCase()
      if (msg.includes('insufficient_balance')) {
        return NextResponse.json(
          { error: `Cannot remove ${data.amount}h — only the available balance can be removed.` },
          { status: 400 }
        )
      }
      if (msg.includes('training_not_found')) {
        return NextResponse.json({ error: 'Training record not found.' }, { status: 404 })
      }
      console.error('adjust_hours_atomic error:', rpcError)
      return NextResponse.json({ error: 'Failed to update training.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, new_balance: newBalance })
  } catch (err) {
    console.error('Hours update error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
