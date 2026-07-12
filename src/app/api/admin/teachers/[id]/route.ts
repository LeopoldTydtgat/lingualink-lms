import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { UpdateTeacherSchema } from '@/lib/validation/schemas'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function verifyAdmin() {
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
  if (authError || !user) return null

  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('account_types, role')
    .eq('id', user.id)
    .single()

  const isAdmin =
    adminProfile?.role === 'admin' ||
    (adminProfile?.account_types ?? []).includes('school_admin')

  return isAdmin ? user : null
}

// ─── PATCH — update teacher profile ──────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const parsed = UpdateTeacherSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

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

    const adminClient = createAdminClient()

    const { data: current, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, timezone, account_types, status, role, teacher_type, contract_start, orientation_date, observed_lesson_date, date_of_birth, follow_up_date, title, gender, nationality, phone, street_address, area_code, city, paypal_email, iban, bic, vat_required, tax_number, hourly_rate, currency, native_languages, teaching_languages, specialties, bio, quote, admin_notes, follow_up_reason, preferred_payment_type, is_active')
      .eq('id', id)
      .single<Record<string, unknown>>()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    const SKIP_FIELDS = [
      'admin_notes',
      'updated_at',
      'created_at',
      // Accepted by UpdateTeacherSchema but intentionally NOT in updatePayload —
      // these are never written by this route, so they must not generate history rows.
      'is_active',
      'preferred_payment_type',
    ]
    const historyEntries = Object.entries(parsed.data)
      .filter(([key]) => !SKIP_FIELDS.includes(key))
      .filter(([key, newVal]) => {
        const oldVal = current[key]
        return JSON.stringify(oldVal) !== JSON.stringify(newVal)
      })
      .map(([key, newVal]) => ({
        teacher_id: id,
        field_name: key,
        old_value: current[key] != null ? String(current[key]) : null,
        new_value: newVal != null ? String(newVal) : null,
        changed_by: user.id,
        changed_at: new Date().toISOString(),
      }))

    // Build an explicit payload so unknown keys from the request body never
    // reach PostgREST — a single unrecognised column aborts the entire update.
    const updatePayload = {
      full_name:             parsed.data.full_name,
      timezone:              parsed.data.timezone,
      account_types:         parsed.data.account_types,
      status:                parsed.data.status,
      role:                  parsed.data.role,
      teacher_type:          parsed.data.teacher_type,
      contract_start:        parsed.data.contract_start        ?? null,
      orientation_date:      parsed.data.orientation_date      ?? null,
      observed_lesson_date:  parsed.data.observed_lesson_date  ?? null,
      title:                 parsed.data.title                 ?? null,
      date_of_birth:         parsed.data.date_of_birth         ?? null,
      gender:                parsed.data.gender                ?? null,
      nationality:           parsed.data.nationality           ?? null,
      phone:                 parsed.data.phone                 ?? null,
      street_address:        parsed.data.street_address        ?? null,
      area_code:             parsed.data.area_code             ?? null,
      city:                  parsed.data.city                  ?? null,
      paypal_email:          parsed.data.paypal_email          ?? null,
      iban:                  parsed.data.iban                  ?? null,
      bic:                   parsed.data.bic                   ?? null,
      vat_required:          parsed.data.vat_required          ?? false,
      tax_number:            parsed.data.tax_number            ?? null,
      hourly_rate:           parsed.data.hourly_rate           ?? null,
      currency:              parsed.data.currency              ?? 'EUR',
      native_languages:      parsed.data.native_languages      ?? [],
      teaching_languages:    parsed.data.teaching_languages    ?? [],
      specialties:           parsed.data.specialties           ?? null,
      bio:                   parsed.data.bio                   ?? null,
      quote:                 parsed.data.quote                 ?? null,
      admin_notes:           parsed.data.admin_notes           ?? null,
      follow_up_date:        parsed.data.follow_up_date        ?? null,
      follow_up_reason:      parsed.data.follow_up_reason      ?? null,
      updated_at:            new Date().toISOString(),
    }

    const { error: updateError } = await adminClient
      .from('profiles')
      .update(updatePayload)
      .eq('id', id)

    if (updateError) {
      console.error('Profile update error:', JSON.stringify(updateError, null, 2))
      return NextResponse.json(
        { error: updateError.message || 'Failed to update teacher.' },
        { status: 500 }
      )
    }

    if (historyEntries.length > 0) {
      const { error: historyError } = await adminClient
        .from('teacher_history_log')
        .insert(historyEntries)

      if (historyError) {
        console.error('History log error:', historyError)
      }
    }

    if (parsed.data.status === 'former' || parsed.data.status === 'on_hold') {
      // Archiving must remove ALL access, not just current sessions. signOut
      // alone leaves the password valid, so a former teacher could log straight
      // back in. Ban the auth user first (locks login), then kill live sessions
      // — so sessions die only after the login is already locked. The ban is
      // lifted again when status returns to 'current' below.
      try {
        await adminClient.auth.admin.updateUserById(id, { ban_duration: '876000h' })
      } catch (banError) {
        // The ban is the security-critical half: if it throws, the login is NOT
        // locked. Hard-fail with 500 rather than returning success — otherwise we
        // re-open the exact hole this block closes (a former teacher logging back
        // in). The admin retries; the profile is already 'former' so re-running is
        // idempotent. signOut below is skipped, but is moot until the ban lands.
        console.error('[archive teacher] ban failed:', banError)
        return NextResponse.json(
          { error: 'Failed to revoke teacher access. Please retry.' },
          { status: 500 }
        )
      }
      try {
        await adminClient.auth.admin.signOut(id, 'global')
      } catch (signOutError) {
        console.error('[archive teacher] signOut failed:', signOutError)
      }
    } else if (parsed.data.status === 'current') {
      // Reinstating a teacher must restore login by lifting any prior ban.
      try {
        await adminClient.auth.admin.updateUserById(id, { ban_duration: 'none' })
      } catch (unbanError) {
        console.error('[reactivate teacher] unban failed:', unbanError)
      }
    }

    revalidatePath('/account')
    revalidatePath('/upcoming-classes')
    revalidatePath('/dashboard')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ─── DELETE — purge only if pristine ──────────────────────────────────────────
//
// Teachers with ANY history are archived (status 'former', via PATCH), never
// purged. Purge exists solely for zero-history accounts (test accounts,
// mistaken creations). Preflight counts every referencing table; a single
// referencing row anywhere blocks the purge with a 409.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await verifyAdmin()
    if (!user) return NextResponse.json({ error: 'Unauthorised or Forbidden' }, { status: 401 })

    const adminClient = createAdminClient()

    // 1. Verify teacher exists and is 'former'
    const { data: teacher, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, status')
      .eq('id', id)
      .single()

    if (fetchError || !teacher) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    if (teacher.status !== 'former') {
      return NextResponse.json(
        { error: 'Teacher must be archived (status: former) before purging.' },
        { status: 409 }
      )
    }

    // 2. Preflight — exact row counts in every table that references this
    // teacher. The select column is the filtered column itself (never '*') so
    // no column-level REVOKE is ever touched. head:true returns no row data.
    const countBy = (table: string, column: string) =>
      adminClient.from(table).select(column, { count: 'exact', head: true }).eq(column, id)

    // teacher_history_log: only changed_by (this user as ACTOR) blocks;
    // teacher_id rows ABOUT this teacher CASCADE on the profile delete.
    const preflight = [
      { table: 'lessons',                 query: countBy('lessons', 'teacher_id') },
      { table: 'reports',                 query: countBy('reports', 'teacher_id') },
      { table: 'classes',                 query: countBy('classes', 'teacher_id') },
      { table: 'trainings',               query: countBy('trainings', 'teacher_id') },
      { table: 'invoices',                query: countBy('invoices', 'teacher_id') },
      { table: 'reviews',                 query: countBy('reviews', 'teacher_id') },
      { table: 'student_reviews',         query: countBy('student_reviews', 'teacher_id') },
      { table: 'training_teachers',       query: countBy('training_teachers', 'teacher_id') },
      {
        table: 'messages',
        query: adminClient
          .from('messages')
          .select('sender_id', { count: 'exact', head: true })
          .or(`sender_id.eq.${id},receiver_id.eq.${id}`),
      },
      { table: 'support_messages',        query: countBy('support_messages', 'participant_auth_id') },
      { table: 'assignments',             query: countBy('assignments', 'assigned_by') },
      { table: 'hours_log',               query: countBy('hours_log', 'created_by') },
      { table: 'announcements',           query: countBy('announcements', 'created_by') },
      {
        table: 'admin_tasks',
        query: adminClient
          .from('admin_tasks')
          .select('created_by', { count: 'exact', head: true })
          .or(`created_by.eq.${id},assigned_to.eq.${id}`),
      },
      { table: 'export_log',              query: countBy('export_log', 'exported_by') },
      { table: 'teacher_history_log',     query: countBy('teacher_history_log', 'changed_by') },
      { table: 'students',                query: countBy('students', 'academic_advisor_id') },
      { table: 'lesson_join_clicks',      query: countBy('lesson_join_clicks', 'user_id') },
      { table: 'user_action_attempts',    query: countBy('user_action_attempts', 'user_id') },
      { table: 'announcement_dismissals', query: countBy('announcement_dismissals', 'user_id') },
    ]

    const results = await Promise.all(preflight.map((p) => p.query))

    const blocking: { table: string; count: number }[] = []
    for (let i = 0; i < results.length; i++) {
      const { count, error } = results[i]
      // Fail closed: an errored (or null) count is unknown, never zero.
      if (error || count === null) {
        console.error(
          `[purge teacher] preflight count failed for ${preflight[i].table}:`,
          error
        )
        return NextResponse.json(
          { error: 'Failed to verify teacher history. Purge aborted; nothing was deleted.' },
          { status: 500 }
        )
      }
      if (count > 0) blocking.push({ table: preflight[i].table, count })
    }

    if (blocking.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot purge: this teacher has history. Archive instead.',
          blocking,
        },
        { status: 409 }
      )
    }

    // 3. Purge — the account is pristine. DB CASCADEs on the profile delete
    // handle availability, availability_overrides, availability_templates, and
    // teacher_history_log.teacher_id; nothing else references this user.

    // 3a. Kill every live session first. Non-fatal: on a retry after a partial
    // failure the auth user may already be gone, which makes this throw.
    try {
      await adminClient.auth.admin.signOut(id, 'global')
    } catch (signOutError) {
      console.error('[purge teacher] signOut failed (non-fatal):', signOutError)
    }

    // 3b. Delete the auth user. Tolerate ONLY user-not-found so a retry after
    // a partial failure (auth gone, profile row left) is idempotent; any other
    // error aborts with the profile row untouched.
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(id)
    if (authDeleteError) {
      const isUserNotFound =
        authDeleteError.status === 404 || authDeleteError.code === 'user_not_found'
      if (!isUserNotFound) {
        console.error('[purge teacher] auth user delete failed:', authDeleteError)
        return NextResponse.json(
          { error: 'Failed to delete the login account. Purge aborted; nothing was deleted.' },
          { status: 500 }
        )
      }
    }

    // 3c. Delete the profile row (CASCADEs fire here).
    const { error: profileDeleteError } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', id)

    if (profileDeleteError) {
      console.error('[purge teacher] profile delete failed:', profileDeleteError)
      return NextResponse.json(
        {
          error:
            'The login account was deleted but the profile row could not be removed. Retry the purge to finish cleanup.',
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
