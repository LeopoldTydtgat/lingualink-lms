import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { CreateStudentSchema } from '@/lib/validation/schemas'

const resend = new Resend(process.env.RESEND_API_KEY)

// ─── GET – list students (supports ?minimal=true&search=name) ─────────────────
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
    .from('students')
    .select(minimal ? 'id, full_name' : 'id, full_name, email, status, company_id, photo_url')
    .order('full_name')

  if (search) {
    query = query.ilike('full_name', `%${search}%`)
  }

  if (minimal) query = query.limit(50)

  const { data: students, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ students: students ?? [] })
}

// ─── POST – create student ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // ── 1. Validate input ────────────────────────────────────────────────────
    const parsed = CreateStudentSchema.safeParse(body)
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

    // ── 4. Upsert the student row ────────────────────────────────────────────
    const { data: studentRow, error: studentError } = await adminClient
      .from('students')
      .upsert({
        auth_user_id: newUserId,
        full_name: data.full_name,
        email: data.email,
        timezone: data.timezone,
        language_preference: data.language_preference ?? null,
        status: data.status,
        is_active: true,
        is_private: data.is_private ?? true,
        company_id: data.company_id ?? null,
        academic_advisor_id: data.academic_advisor_id ?? null,
        customer_number: data.customer_number ?? null,
        date_of_birth: data.date_of_birth ?? null,
        phone: data.phone ?? null,
        native_language: data.native_language ?? null,
        learning_language: data.learning_language ?? null,
        current_fluency_level: data.current_fluency_level ?? null,
        self_assessed_level: data.self_assessed_level ?? null,
        self_reported_level: data.self_assessed_level ?? null,
        learning_goals: data.learning_goals ?? null,
        interests: data.interests ?? null,
        cancellation_policy: data.cancellation_policy,
        admin_notes: data.admin_notes ?? null,
        teacher_notes: data.teacher_notes ?? null,
      })
      .select('id')
      .single()

    if (studentError || !studentRow) {
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Student row error:', studentError)
      return NextResponse.json(
        { error: 'Failed to create student record.' },
        { status: 500 }
      )
    }

    const studentId = studentRow.id

    // ── 5. Create the training record ────────────────────────────────────────
    const { data: trainingRow, error: trainingError } = await adminClient
      .from('trainings')
      .insert({
        student_id: studentId,
        package_name: data.package_name,
        package_type: data.package_name,
        total_hours: data.total_hours,
        hours_consumed: 0,
        end_date: data.end_date,
        status: 'active',
        low_hours_warning_sent: false,
      })
      .select('id')
      .single()

    if (trainingError || !trainingRow) {
      await adminClient.from('students').delete().eq('id', studentId)
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Training insert error:', trainingError)
      return NextResponse.json(
        { error: 'Failed to create training record.' },
        { status: 500 }
      )
    }

    const trainingId = trainingRow.id

    // ── 6. Insert training_teachers rows ─────────────────────────────────────
    if (data.assigned_teacher_ids.length > 0) {
      const ttRows = data.assigned_teacher_ids.map((teacherId: string) => ({
        training_id: trainingId,
        teacher_id: teacherId,
      }))
      const { error: ttError } = await adminClient
        .from('training_teachers')
        .insert(ttRows)
      if (ttError) console.error('training_teachers insert error:', ttError)
    }

    // ── 7. Send welcome email ────────────────────────────────────────────────
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
              <p style="color: #374151;">Your student account has been created. Please click the button below to set your password and access the portal.</p>
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

    return NextResponse.json({ success: true, id: studentId })
  } catch (err) {
    console.error('Create student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
