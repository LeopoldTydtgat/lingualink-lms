import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { CreateCompanySchema } from '@/lib/validation/schemas'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

// ─── GET — list companies (supports ?minimal=true) ────────────────────────────
export async function GET(req: NextRequest) {
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

  // Gate via the shared canonical rule; `supabase` (the RLS-bound client
  // above) stays for the companies query below.
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const minimal = searchParams.get('minimal') === 'true'

  const { data: companies, error } = await supabase
    .from('companies')
    .select(minimal ? 'id, name' : 'id, name, type, contact_name, contact_email, status, cancellation_policy')
    .eq('status', 'active')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ companies: companies ?? [] })
}

// ─── POST — create company ───────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // --- 1. Verify admin ---
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // --- 2. Validate ---
    // companies carries CHECK constraints on type, status and
    // cancellation_policy. Parsing here turns a value outside those sets into a
    // 400 instead of a 23514 the insert below would surface as an opaque 500 —
    // and a silently-stored bad cancellation_policy never matches the '48hr'
    // test in getBillability, quietly dropping the company's 24-48hr billing.
    const parsed = CreateCompanySchema.safeParse(body)
    if (!parsed.success) {
      console.error('Company create validation failed:', parsed.error.issues)
      return NextResponse.json({ error: 'Invalid request data.' }, { status: 400 })
    }
    const fields = parsed.data
    // --- 3. Insert ---
    // Built from the PARSED data only — `body` is not read past this point.
    // name arrives already trimmed; the enums are guaranteed present, so their
    // old `??` defaults are gone. The optional text fields keep the previous
    // empty-string-clears-the-field shape.
    const adminClient = createAdminClient()
    const { data: company, error: insertError } = await adminClient
      .from('companies')
      .insert({
        name: fields.name,
        type: fields.type,
        contact_name: fields.contact_name || null,
        contact_email: fields.contact_email || null,
        contact_phone: fields.contact_phone || null,
        country: fields.country || null,
        billing_email: fields.billing_email || null,
        cancellation_policy: fields.cancellation_policy,
        tags: fields.tags ?? [],
        notes: fields.notes || null,
        status: fields.status,
      })
      .select('id')
      .single()
    if (insertError) {
      console.error('Company insert error:', insertError)
      return NextResponse.json({ error: 'Failed to create company.' }, { status: 500 })
    }
    return NextResponse.json({ id: company.id })
  } catch (err) {
    console.error('POST company error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
