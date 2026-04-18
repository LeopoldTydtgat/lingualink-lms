import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'

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
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    const SKIP_FIELDS = ['admin_notes', 'updated_at', 'created_at']
    const historyEntries = Object.entries(body)
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
      full_name:             body.full_name,
      timezone:              body.timezone,
      account_types:         body.account_types,
      status:                body.status,
      role:                  body.role,
      teacher_type:          body.teacher_type,
      contract_start:        body.contract_start        ?? null,
      orientation_date:      body.orientation_date      ?? null,
      observed_lesson_date:  body.observed_lesson_date  ?? null,
      title:                 body.title                 ?? null,
      date_of_birth:         body.date_of_birth         ?? null,
      gender:                body.gender                ?? null,
      nationality:           body.nationality           ?? null,
      phone:                 body.phone                 ?? null,
      street_address:        body.street_address        ?? null,
      area_code:             body.area_code             ?? null,
      city:                  body.city                  ?? null,
      paypal_email:          body.paypal_email          ?? null,
      iban:                  body.iban                  ?? null,
      bic:                   body.bic                   ?? null,
      vat_required:          body.vat_required          ?? false,
      tax_number:            body.tax_number            ?? null,
      hourly_rate:           body.hourly_rate           ?? null,
      currency:              body.currency              ?? 'EUR',
      native_languages:      body.native_languages      ?? [],
      teaching_languages:    body.teaching_languages    ?? [],
      specialties:           body.specialties           ?? null,
      bio:                   body.bio                   ?? null,
      quote:                 body.quote                 ?? null,
      admin_notes:           body.admin_notes           ?? null,
      follow_up_date:        body.follow_up_date        ?? null,
      follow_up_reason:      body.follow_up_reason      ?? null,
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

    revalidatePath('/account')
    revalidatePath('/upcoming-classes')
    revalidatePath('/dashboard')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ─── DELETE — permanently purge teacher and all associated data ───────────────

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

    // 2. Check all linked students are 'former'
    const { data: linkedLessons } = await adminClient
      .from('lessons')
      .select('student_id')
      .eq('teacher_id', id)
      .not('student_id', 'is', null)

    const linkedStudentIds = [
      ...new Set((linkedLessons || []).map((l: { student_id: string }) => l.student_id)),
    ]

    if (linkedStudentIds.length > 0) {
      const { data: nonFormerStudents } = await adminClient
        .from('students')
        .select('full_name')
        .in('id', linkedStudentIds)
        .neq('status', 'former')

      if (nonFormerStudents && nonFormerStudents.length > 0) {
        return NextResponse.json(
          {
            error: `Cannot purge: the following students must be archived first.`,
            blockedBy: nonFormerStudents.map((s: { full_name: string }) => s.full_name),
          },
          { status: 409 }
        )
      }
    }

    // 3. Cascade delete in dependency order

    // 3a. messages
    await adminClient
      .from('messages')
      .delete()
      .or(`sender_id.eq.${id},receiver_id.eq.${id}`)

    // 3b. Get lesson IDs
    const { data: lessonRows } = await adminClient
      .from('lessons')
      .select('id')
      .eq('teacher_id', id)
    const lessonIds = (lessonRows || []).map((l: { id: string }) => l.id)

    if (lessonIds.length > 0) {
      // 3c. Get assignment IDs linked to these lessons
      const { data: assignmentRows } = await adminClient
        .from('assignments')
        .select('id')
        .in('lesson_id', lessonIds)
      const assignmentIds = (assignmentRows || []).map((a: { id: string }) => a.id)

      // 3d. Delete exercise_completions tied to those assignments
      if (assignmentIds.length > 0) {
        await adminClient
          .from('exercise_completions')
          .delete()
          .in('assignment_id', assignmentIds)
      }

      // 3e. Delete assignments
      await adminClient.from('assignments').delete().in('lesson_id', lessonIds)

      // 3f. Delete reports
      await adminClient.from('reports').delete().in('class_id', lessonIds)
    }

    // 3g. Delete invoices
    await adminClient.from('invoices').delete().eq('teacher_id', id)

    // 3h. Delete lessons
    await adminClient.from('lessons').delete().eq('teacher_id', id)

    // 3i. Delete training_teachers
    await adminClient.from('training_teachers').delete().eq('teacher_id', id)

    // 3j. Delete student_reviews
    await adminClient.from('student_reviews').delete().eq('teacher_id', id)

    // 3k. Delete teacher_history_log
    await adminClient.from('teacher_history_log').delete().eq('teacher_id', id)

    // 3l. Delete profile row
    await adminClient.from('profiles').delete().eq('id', id)

    // 3m. Delete Supabase auth user (teacher id === auth user id for profiles)
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(id)
    if (authDeleteError) {
      // Non-fatal — profile is already deleted; log and continue
      console.error('Auth user delete error (non-fatal):', authDeleteError)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
