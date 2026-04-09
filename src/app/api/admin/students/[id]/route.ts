import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
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

    // Use service role for all writes
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // --- 2. Verify the student exists ---
    const { data: current, error: fetchError } = await adminClient
      .from('students')
      .select('id')
      .eq('id', id)
      .single()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    // --- 3. Extract fields destined for each table ---
    const {
      assigned_teacher_ids,
      training_id,
      package_name,
      total_hours,
      end_date,
      // Everything else goes to the students table
      ...studentFields
    } = body

    // --- 4. Update the students table ---
    const { error: studentError } = await adminClient
      .from('students')
      .update({ ...studentFields, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (studentError) {
      console.error('Student update error:', studentError)
      return NextResponse.json({ error: 'Failed to update student.' }, { status: 500 })
    }

    // --- 5. Update the active training if training fields were provided ---
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

    // --- 6. Update assigned teachers if provided ---
    // Delete all existing training_teachers rows for this training, then re-insert
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

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
