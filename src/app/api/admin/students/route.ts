import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // --- 1. Verify the requesting user is an admin ---
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

    // --- 2. Create the Supabase auth user using the service role key ---
    // Service role bypasses RLS — only used server-side, never exposed to client
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email: body.email,
      password: body.temp_password,
      email_confirm: true, // skip email confirmation — we send our own welcome email
    })

    if (createError || !newUser.user) {
      console.error('Auth user creation error:', createError)
      return NextResponse.json(
        { error: createError?.message || 'Failed to create auth user.' },
        { status: 400 }
      )
    }

    const newUserId = newUser.user.id

    // --- 3. Upsert the student row ---
    // Always upsert (not insert) — Supabase may auto-create a row on auth user creation
    const { data: studentRow, error: studentError } = await adminClient
      .from('students')
      .upsert({
        auth_user_id: newUserId,
        full_name: body.full_name,
        email: body.email,
        timezone: body.timezone || 'Europe/Paris',
        language_preference: body.language_preference || null,
        status: body.status || 'current',
        is_active: true,
        is_private: body.is_private ?? true,
        company_id: body.company_id || null,
        academic_advisor_id: body.academic_advisor_id || null,
        customer_number: body.customer_number || null,
        date_of_birth: body.date_of_birth || null,
        phone: body.phone || null,
        native_language: body.native_language || null,
        learning_language: body.learning_language || null,
        current_fluency_level: body.current_fluency_level || null,
        self_assessed_level: body.self_assessed_level || null,
        self_reported_level: body.self_assessed_level || null, // keep both in sync
        learning_goals: body.learning_goals || null,
        interests: body.interests || null,
        cancellation_policy: body.cancellation_policy || '24hr',
        admin_notes: body.admin_notes || null,
        teacher_notes: body.teacher_notes || null,
      })
      .select('id')
      .single()

    if (studentError || !studentRow) {
      // Roll back the auth user if student row insert fails
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Student row error:', studentError)
      return NextResponse.json(
        { error: 'Failed to create student record.' },
        { status: 500 }
      )
    }

    const studentId = studentRow.id

    // --- 4. Create the training record ---
    const { data: trainingRow, error: trainingError } = await adminClient
      .from('trainings')
      .insert({
        student_id: studentId,
        package_name: body.package_name,
        package_type: body.package_name, // mirror to package_type for backwards compat
        total_hours: body.total_hours,
        hours_consumed: 0,
        end_date: body.end_date,
        status: 'active',
        low_hours_warning_sent: false,
      })
      .select('id')
      .single()

    if (trainingError || !trainingRow) {
      // Roll back student row and auth user
      await adminClient.from('students').delete().eq('id', studentId)
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Training insert error:', trainingError)
      return NextResponse.json(
        { error: 'Failed to create training record.' },
        { status: 500 }
      )
    }

    const trainingId = trainingRow.id

    // --- 5. Insert training_teachers rows for each assigned teacher ---
    if (body.assigned_teacher_ids?.length > 0) {
      const ttRows = body.assigned_teacher_ids.map((teacherId: string) => ({
        training_id: trainingId,
        teacher_id: teacherId,
      }))

      const { error: ttError } = await adminClient
        .from('training_teachers')
        .insert(ttRows)

      if (ttError) {
        // Non-fatal — log but don't roll back. Student and training are created.
        // Admin can fix assignments from the student detail page.
        console.error('training_teachers insert error:', ttError)
      }
    }

    // --- 6. Send welcome email with password reset link ---
    const { data: resetData, error: resetError } =
      await adminClient.auth.admin.generateLink({
        type: 'recovery',
        email: body.email,
      })

    if (!resetError && resetData?.properties?.action_link) {
      await resend.emails.send({
        from: 'no-reply@lingualinkonline.com',
        to: body.email,
        subject: 'Welcome to Lingualink Online — Set Your Password',
        html: `
          <div style="font-family: Inter, sans-serif; max-width: 560px; margin: 0 auto;">
            <div style="background-color: #FF8303; padding: 24px; border-radius: 8px 8px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 20px;">Welcome to Lingualink Online</h1>
            </div>
            <div style="padding: 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #374151;">Dear ${body.full_name},</p>
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
