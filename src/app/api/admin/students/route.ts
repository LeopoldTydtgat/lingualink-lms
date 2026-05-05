import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import resend from '@/lib/email/client'
import { CreateStudentSchema } from '@/lib/validation/schemas'
import { buildEmailTemplate } from '@/lib/email/templates'

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
    const supabase = await createServerSupabaseClient()

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

    // ── Cross-role email guard: reject if a teacher already uses this email ──
    const guardClient = createAdminClient()
    const { data: existingTeacher } = await guardClient
      .from('profiles')
      .select('id')
      .eq('email', data.email)
      .maybeSingle()
    if (existingTeacher) {
      return NextResponse.json(
        { error: 'This email is already in use by a teacher account. Each email can only belong to one role.' },
        { status: 409 }
      )
    }

    // ── 3. Create the Supabase auth user using the service role key ──────────
    const adminClient = createAdminClient()

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
        profile_completed: false,
        company_id: data.company_id ?? null,
        academic_advisor_id: data.academic_advisor_id ?? null,
        customer_number: data.customer_number ?? null,
        date_of_birth: data.date_of_birth ?? null,
        phone: data.phone ?? null,
        native_language: data.native_language ?? null,
        learning_language: data.learning_language ?? null,
        current_fluency_level: data.current_fluency_level ?? null,
        self_assessed_level: null,
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
        end_date: data.end_date ?? null,
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

    // ── 6a. Notify assigned teachers ─────────────────────────────────────────
    if (data.assigned_teacher_ids.length > 0) {
      const { data: teacherProfiles } = await adminClient
        .from('profiles')
        .select('id, full_name, email')
        .in('id', data.assigned_teacher_ids)

      if (teacherProfiles && teacherProfiles.length > 0) {
        const endDateLabel = data.end_date
          ? new Intl.DateTimeFormat('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(data.end_date))
          : 'No end date'

        const teacherEmailBody = `
          <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
            A new student has been assigned to you on the Lingualink Online portal.
          </p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
            <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Student:</strong> ${data.full_name}</td></tr>
            <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Package:</strong> ${data.package_name}</td></tr>
            <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>End Date:</strong> ${endDateLabel}</td></tr>
          </table>
          <table cellpadding="0" cellspacing="0" style="margin:0;">
            <tr>
              <td>
                <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${process.env.NEXT_PUBLIC_TEACHER_URL}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="13%" stroke="f" fillcolor="#FF8303"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">View Student Profile</center></v:roundrect><![endif]-->
                <!--[if !mso]><!-->
                <a href="${process.env.NEXT_PUBLIC_TEACHER_URL}" style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;">View Student Profile</a>
                <!--<![endif]-->
              </td>
            </tr>
          </table>
        `

        try {
          await Promise.allSettled(
            teacherProfiles.map((teacher: { id: string; full_name: string; email: string }) =>
              resend.emails.send({
                from: 'no-reply@lingualinkonline.com',
                to: teacher.email,
                subject: 'Lingualink Online — You have been assigned a new student',
                html: buildEmailTemplate({
                  recipientName: teacher.full_name,
                  recipientFallback: 'Teacher',
                  subject: 'Lingualink Online — You have been assigned a new student',
                  bodyHtml: teacherEmailBody,
                  contactEmail: 'teachers@lingualinkonline.com',
                }),
              })
            )
          )
        } catch (emailErr) {
          console.error('Teacher assignment email error:', emailErr)
        }
      }
    }

    return NextResponse.json({ success: true, id: studentId })
  } catch (err) {
    console.error('Create student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
