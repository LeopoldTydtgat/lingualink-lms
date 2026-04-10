import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { CreateTeacherSchema } from '@/lib/validation/schemas'

const resend = new Resend(process.env.RESEND_API_KEY)

// ─── GET – list teachers (supports ?minimal=true&search=name) ─────────────────
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
    (profile?.account_types ?? []).includes('staff') ||
    (profile?.account_types ?? []).includes('hr_admin')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const minimal = searchParams.get('minimal') === 'true'
  const search = searchParams.get('search') ?? ''

  let query = supabase
    .from('profiles')
    .select(minimal ? 'id, full_name' : 'id, full_name, email, status, account_types, hourly_rate, photo_url')
    .not('account_types', 'is', null)
    .order('full_name')

  // Only return actual teachers (not pure admin/HR accounts)
  query = query.contains('account_types', ['teacher'])

  if (search) {
    query = query.ilike('full_name', `%${search}%`)
  }

  // For minimal mode (autocomplete) limit results
  if (minimal) query = query.limit(50)

  const { data: teachers, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ teachers: teachers ?? [] })
}

// ─── POST – create teacher ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // ── 1. Validate input ────────────────────────────────────────────────────
    const parsed = CreateTeacherSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const data = parsed.data

    // ── 2. Verify the requesting user is an admin ────────────────────────────
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

    // ── 3. Create the Supabase auth user using the service role key ──────────
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email: data.email,
      password: data.temp_password,
      email_confirm: true,
    })

    if (createError || !newUser.user) {
      console.error('Auth user creation error:', createError)
      return NextResponse.json(
        { error: createError?.message || 'Failed to create auth user.' },
        { status: 400 }
      )
    }

    const newUserId = newUser.user.id

    // ── 4. Insert the profile row ────────────────────────────────────────────
    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert({
        id: newUserId,
        email: data.email,
        full_name: data.full_name,
        role: data.account_types.includes('school_admin') ? 'admin' : 'teacher',
        timezone: data.timezone,
        bio: data.bio ?? null,
        teaching_languages: data.teaching_languages ?? [],
        speaking_languages: data.native_languages ?? [],
        is_active: true,
        preferred_payment_type: null,
        paypal_email: data.paypal_email ?? null,
        iban: data.iban ?? null,
        bic: data.bic ?? null,
        tax_number: data.tax_number ?? null,
        street_address: data.street_address ?? null,
        area_code: data.area_code ?? null,
        city: data.city ?? null,
        hourly_rate: data.hourly_rate ?? null,
        contract_start: data.contract_start ?? null,
        orientation_date: data.orientation_date ?? null,
        observed_lesson_date: data.observed_lesson_date ?? null,
        vat_required: data.vat_required ?? false,
        account_types: data.account_types,
        teacher_type: data.account_types.includes('teacher_exam') ? 'teacher_exam' : 'teacher',
        status: data.status,
        follow_up_date: data.follow_up_date ?? null,
        follow_up_reason: data.follow_up_reason ?? null,
        admin_notes: data.admin_notes ?? null,
        native_languages: data.native_languages ?? [],
        specialties: data.specialties ?? null,
        quote: data.quote ?? null,
        video_url: data.video_url ?? null,
      })

    if (profileError) {
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Profile insert error:', profileError)
      return NextResponse.json(
        { error: 'Failed to create teacher profile.' },
        { status: 500 }
      )
    }

    // ── 5. Send welcome email with password reset link ───────────────────────
    const { data: resetData, error: resetError } =
      await adminClient.auth.admin.generateLink({
        type: 'recovery',
        email: data.email,
      })

    if (!resetError && resetData?.properties?.action_link) {
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: data.email,
        subject: 'Welcome to Lingualink Online – Set Your Password',
        html: `
          <div style="font-family: Inter, sans-serif; max-width: 560px; margin: 0 auto;">
            <div style="background-color: #FF8303; padding: 24px; border-radius: 8px 8px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 20px;">Welcome to Lingualink Online</h1>
            </div>
            <div style="padding: 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #374151;">Dear ${data.full_name},</p>
              <p style="color: #374151;">Your teacher account has been created. Please click the button below to set your password and access the portal.</p>
              <a href="${resetData.properties.action_link}"
                style="display: inline-block; background-color: #FF8303; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">
                Set My Password
              </a>
              <p style="color: #6b7280; font-size: 13px;">This link expires in 24 hours. If you have any questions contact us at ${process.env.ADMIN_EMAIL ?? 'admin@lingualinkonline.com'}.</p>
            </div>
          </div>
        `,
      })
    }

    return NextResponse.json({ success: true, id: newUserId })
  } catch (err) {
    console.error('Create teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
