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

// ─── PATCH — update student ───────────────────────────────────────────────────

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
      .from('students')
      .select('id')
      .eq('id', id)
      .single()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    const {
      assigned_teacher_ids,
      training_id,
      package_name,
      total_hours,
      end_date,
      ...studentFields
    } = body

    const { error: studentError } = await adminClient
      .from('students')
      .update({ ...studentFields, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (studentError) {
      console.error('Student update error:', studentError)
      return NextResponse.json({ error: 'Failed to update student.' }, { status: 500 })
    }

    if (training_id && (package_name !== undefined || total_hours !== undefined || end_date !== undefined)) {
      const trainingUpdate: Record<string, unknown> = {}
      if (package_name !== undefined) trainingUpdate.package_name = package_name
      if (total_hours !== undefined) trainingUpdate.total_hours = total_hours
      if (end_date !== undefined) trainingUpdate.end_date = end_date

      const { error: trainingError } = await adminClient
        .from('trainings')
        .update(trainingUpdate)
        .eq('id', training_id)

      if (trainingError) {
        console.error('Training update error:', trainingError)
        return NextResponse.json({ error: 'Failed to update training.' }, { status: 500 })
      }
    }

    if (training_id && Array.isArray(assigned_teacher_ids)) {
      const { error: deleteError } = await adminClient
        .from('training_teachers')
        .delete()
        .eq('training_id', training_id)

      if (deleteError) {
        console.error('training_teachers delete error:', deleteError)
        return NextResponse.json({ error: 'Failed to update assigned teachers.' }, { status: 500 })
      }

      if (assigned_teacher_ids.length > 0) {
        const rows = assigned_teacher_ids.map((tid: string) => ({
          training_id,
          teacher_id: tid,
        }))

        const { error: insertError } = await adminClient
          .from('training_teachers')
          .insert(rows)

        if (insertError) {
          console.error('training_teachers insert error:', insertError)
          return NextResponse.json({ error: 'Failed to assign teachers.' }, { status: 500 })
        }
      }
    }

    revalidatePath('/student/account')
    revalidatePath('/student/dashboard')
    revalidatePath('/upcoming-classes')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ─── DELETE — permanently purge student and all associated data ───────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await verifyAdmin()
    if (!user) return NextResponse.json({ error: 'Unauthorised or Forbidden' }, { status: 401 })

    const adminClient = createAdminClient()

    // 1. Verify student exists and is 'former'
    const { data: student, error: fetchError } = await adminClient
      .from('students')
      .select('id, full_name, status, auth_user_id')
      .eq('id', id)
      .single()

    if (fetchError || !student) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    if (student.status !== 'former') {
      return NextResponse.json(
        { error: 'Student must be archived (status: former) before purging.' },
        { status: 409 }
      )
    }

    // 2. Check all linked teachers are 'former'
    const { data: linkedLessons } = await adminClient
      .from('lessons')
      .select('teacher_id')
      .eq('student_id', id)
      .not('teacher_id', 'is', null)

    const linkedTeacherIds = [
      ...new Set((linkedLessons || []).map((l: { teacher_id: string }) => l.teacher_id)),
    ]

    if (linkedTeacherIds.length > 0) {
      const { data: nonFormerTeachers } = await adminClient
        .from('profiles')
        .select('full_name')
        .in('id', linkedTeacherIds)
        .neq('status', 'former')

      if (nonFormerTeachers && nonFormerTeachers.length > 0) {
        return NextResponse.json(
          {
            error: `Cannot purge: the following teachers must be archived first.`,
            blockedBy: nonFormerTeachers.map((t: { full_name: string }) => t.full_name),
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

    // 3b. exercise_completions (keyed by student_id)
    await adminClient.from('exercise_completions').delete().eq('student_id', id)

    // 3c. assignments (keyed by student_id)
    await adminClient.from('assignments').delete().eq('student_id', id)

    // 3d. Get lesson IDs for this student
    const { data: lessonRows } = await adminClient
      .from('lessons')
      .select('id')
      .eq('student_id', id)
    const lessonIds = (lessonRows || []).map((l: { id: string }) => l.id)

    // 3e. Delete reports for these lessons
    if (lessonIds.length > 0) {
      await adminClient.from('reports').delete().in('class_id', lessonIds)
    }

    // 3f. Delete lessons
    await adminClient.from('lessons').delete().eq('student_id', id)

    // 3g. Get training IDs for this student
    const { data: trainingRows } = await adminClient
      .from('trainings')
      .select('id')
      .eq('student_id', id)
    const trainingIds = (trainingRows || []).map((t: { id: string }) => t.id)

    // 3h. Delete training_teachers
    if (trainingIds.length > 0) {
      await adminClient.from('training_teachers').delete().in('training_id', trainingIds)
    }

    // 3i. Delete trainings
    await adminClient.from('trainings').delete().eq('student_id', id)

    // 3j. Delete hours_log
    await adminClient.from('hours_log').delete().eq('student_id', id)

    // 3k. Delete student_reviews
    await adminClient.from('student_reviews').delete().eq('student_id', id)

    // 3l. Delete the student record
    await adminClient.from('students').delete().eq('id', id)

    // 3m. Delete Supabase auth user
    const authUserId = student.auth_user_id as string | null
    if (authUserId) {
      const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(authUserId)
      if (authDeleteError) {
        console.error('Auth user delete error (non-fatal):', authDeleteError)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
