import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { TEACHER_PROFILE_FILTER } from '@/lib/auth/isTeacherProfile'
import { NextRequest, NextResponse } from 'next/server'
import { CreateTeacherSchema } from '@/lib/validation/schemas'
import { generateThrowawayPassword, sendAccountInviteEmail } from '@/lib/auth/inviteEmail'

// ─── GET – list teachers (supports ?minimal=true&search=name) ─────────────────
export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const minimal = searchParams.get('minimal') === 'true'
  const search = searchParams.get('search') ?? ''

  // email + hourly_rate must not be read through the RLS-bound client.
  // hourly_rate has no column SELECT grant for authenticated (per-column grant
  // model) — reading it through an RLS-bound client fails. The isAdmin gate
  // above already authorised this list — run it on the admin client. The
  // auth/role check before the gate stays on the RLS client. (NEW262d)
  const adminClient = createAdminClient()
  let query = adminClient
    .from('profiles')
    .select(minimal ? 'id, full_name' : 'id, full_name, email, status, account_types, hourly_rate, photo_url')
    // THE canonical teacher rule - src/lib/auth/isTeacherProfile.ts. Replaces
    // the old `.not(account_types,is,null)` + `.contains(['teacher'])` pair,
    // which silently dropped teacher_exam-only and role-admin profiles and so
    // disagreed with the Teachers list page. The null guard goes with it: the
    // filter itself already excludes null account_types except via role.eq.admin,
    // where the rule says the profile IS managed as a teacher.
    .or(TEACHER_PROFILE_FILTER)
    .order('full_name')

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
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Cross-role email guard: reject if a student already uses this email ──
    const guardClient = createAdminClient()
    const { data: existingStudent } = await guardClient
      .from('students')
      .select('id')
      .eq('email', data.email)
      .maybeSingle()
    if (existingStudent) {
      return NextResponse.json(
        { error: 'This email is already in use by a student account. Each email can only belong to one role.' },
        { status: 409 }
      )
    }

    // ── 3. Create the Supabase auth user using the service role key ──────────
    const adminClient = createAdminClient()

    // Throwaway password — never returned or logged. The teacher sets their
    // own password via the invite email sent after the profile upsert succeeds.
    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email: data.email,
      password: generateThrowawayPassword(),
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
        // Admin role is never minted from this form.
        role: 'teacher',
        timezone: data.timezone,
        bio: data.bio ?? null,
        qualifications: data.qualifications ?? null,
        teaching_languages: data.teaching_languages ?? [],
        speaking_languages: data.native_languages ?? [],
        preferred_payment_type: data.preferred_payment_type ?? null,
        paypal_email: data.paypal_email ?? null,
        iban: data.iban ?? null,
        bic: data.bic ?? null,
        tax_number: data.tax_number ?? null,
        title: data.title ?? null,
        gender: data.gender ?? null,
        nationality: data.nationality ?? null,
        phone: data.phone ?? null,
        date_of_birth: data.date_of_birth ?? null,
        street_address: data.street_address ?? null,
        area_code: data.area_code ?? null,
        city: data.city ?? null,
        hourly_rate: data.hourly_rate ?? null,
        currency: data.currency ?? 'EUR',
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
        profile_completed: false,
      })

    if (profileError) {
      await adminClient.auth.admin.deleteUser(newUserId)
      console.error('Profile insert error:', profileError)
      return NextResponse.json(
        { error: 'Failed to create teacher profile.' },
        { status: 500 }
      )
    }

    // ── 5. Send the account invite email (best-effort) ──────────────────────
    // Never rolls anything back and never fails the request — the admin is
    // told via inviteEmailSent so they can point the teacher at
    // "Forgot password" if the email did not go out.
    const { sent: inviteEmailSent } = await sendAccountInviteEmail(
      adminClient,
      data.email,
      data.full_name,
      'teacher'
    )

    return NextResponse.json({ success: true, id: newUserId, inviteEmailSent })
  } catch (err) {
    console.error('Create teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
