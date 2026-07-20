import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
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

// ─── POST — create company (unchanged) ───────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
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
    // --- 3. Insert ---
    const adminClient = createAdminClient()
    const { data: company, error: insertError } = await adminClient
      .from('companies')
      .insert({
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
