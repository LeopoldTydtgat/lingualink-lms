import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
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

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types, role')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (profile?.account_types ?? []).includes('school_admin') ||
    (profile?.account_types ?? []).includes('hr_admin') ||
    (profile?.account_types ?? []).includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
      .select('account_types, role')
      .eq('id', user.id)
      .single()
    const isAdmin =
      adminProfile?.role === 'admin' ||
      (adminProfile?.account_types ?? []).includes('school_admin')
    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // --- 2. Validate ---
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Company name is required.' }, { status: 400 })
    }
    // --- 3. Insert ---
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
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
