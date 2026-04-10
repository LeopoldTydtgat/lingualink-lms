import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { HoursAdjustmentSchema } from '@/lib/validation/schemas'

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

    // ── 4. Fetch current training balance ─────────────────────────────────────
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: training, error: trainError } = await adminClient
      .from('trainings')
      .select('id, total_hours, hours_consumed')
      .eq('id', data.training_id)
      .eq('student_id', studentId)
      .single()

    if (trainError || !training) {
      return NextResponse.json({ error: 'Training record not found.' }, { status: 404 })
    }

    const currentBalance = Number(training.total_hours) - Number(training.hours_consumed)

    // For 'add': increase total_hours (student has more hours available)
    // For 'remove': increase hours_consumed (student has used more hours)
    let newTotalHours = Number(training.total_hours)
    let newHoursConsumed = Number(training.hours_consumed)

    if (data.action === 'add') {
      newTotalHours = newTotalHours + data.amount
    } else {
      if (data.amount > currentBalance) {
        return NextResponse.json(
          { error: `Cannot remove ${data.amount}h — only ${currentBalance}h available.` },
          { status: 400 }
        )
      }
      newHoursConsumed = newHoursConsumed + data.amount
    }

    const newBalance = newTotalHours - newHoursConsumed

    // ── 5. Update the training record ─────────────────────────────────────────
    const { error: updateError } = await adminClient
      .from('trainings')
      .update({
        total_hours: newTotalHours,
        hours_consumed: newHoursConsumed,
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.training_id)

    if (updateError) {
      console.error('Training update error:', updateError)
      return NextResponse.json({ error: 'Failed to update training.' }, { status: 500 })
    }

    // ── 6. Write to hours_log ─────────────────────────────────────────────────
    const { error: logError } = await adminClient
      .from('hours_log')
      .insert({
        student_id: studentId,
        type: data.action === 'add' ? 'add' : 'deduct',
        amount_hours: data.action === 'add' ? data.amount : -data.amount,
        balance_after: newBalance,
        invoice_reference: data.invoice_reference ?? null,
        notes: data.notes ?? null,
        created_by: adminProfile.id,
      })

    if (logError) {
      // Non-fatal — training is already updated. Log the error but don't fail.
      console.error('hours_log insert error:', logError)
    }

    return NextResponse.json({ success: true, new_balance: newBalance })
  } catch (err) {
    console.error('Hours update error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
