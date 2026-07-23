import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { UpdateStudentSchema } from '@/lib/validation/schemas'

// ─── PATCH — update student ───────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const parsed = UpdateStudentSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminClient = createAdminClient()

    const { data: current, error: fetchError } = await adminClient
      .from('students')
      .select('id, auth_user_id')
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
    } = parsed.data

    // Build the payload from ONLY the fields present in the request. The
    // schema is all-optional, so a partial request (e.g. Archive sending just
    // { status }) must never touch the other columns — defaulting absent
    // fields to null wipes the rest of the profile. Zod 4 omits absent
    // optional keys from parsed.data and keeps explicit nulls, so `in` is the
    // correct presence check: absent → not written, null → cleared. The
    // explicit allowlist also excludes id, auth_user_id, created_at,
    // profile_completed and anything else the client is not allowed to set.
    const UPDATABLE_FIELDS = [
      'full_name', 'timezone', 'status', 'date_of_birth', 'phone',
      'language_preference', 'customer_number', 'is_private', 'company_id',
      'academic_advisor_id', 'native_language', 'learning_language',
      'current_fluency_level', 'self_assessed_level', 'learning_goals',
      'interests', 'cancellation_policy', 'admin_notes', 'teacher_notes',
    ] as const

    const studentUpdate: Record<string, unknown> = {}
    for (const key of UPDATABLE_FIELDS) {
      if (key in parsed.data) studentUpdate[key] = parsed.data[key]
    }
    studentUpdate.updated_at = new Date().toISOString()

    const { error: studentError } = await adminClient
      .from('students')
      .update(studentUpdate)
      .eq('id', id)

    if (studentError) {
      console.error('Student update error:', studentError)
      return NextResponse.json({ error: 'Failed to update student.' }, { status: 500 })
    }

    // Non-balance training fields write via a normal .update(). total_hours is
    // deliberately excluded here — it is a billing-balance mutation and routes
    // through adjust_hours_atomic below (NEW141) so the row is locked and a
    // ledger row is recorded.
    if (training_id && (package_name !== undefined || end_date !== undefined)) {
      const trainingUpdate: Record<string, unknown> = {}
      if (package_name !== undefined) trainingUpdate.package_name = package_name
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

    // total_hours (package size) is a balance mutation — it must go through the
    // atomic RPC so the row is locked, the new total can't drop below hours
    // already consumed, and an admin_adjustment ledger row is recorded. Only fire
    // when the value actually changed, so a profile-only edit logs no adjustment.
    if (training_id && total_hours !== undefined) {
      const { data: training, error: trainingFetchError } = await adminClient
        .from('trainings')
        .select('total_hours')
        .eq('id', training_id)
        .eq('student_id', id)
        .maybeSingle()

      if (trainingFetchError || !training) {
        return NextResponse.json({ error: 'Training record not found.' }, { status: 404 })
      }

      if (Number(training.total_hours) !== Number(total_hours)) {
        const { error: rpcError } = await adminClient.rpc('adjust_hours_atomic', {
          p_training_id: training_id,
          p_student_id: id,
          p_action: 'set_total',
          p_amount: Number(total_hours),
          p_log_type: 'admin_adjustment',
          p_created_by: user.id,
          p_invoice_reference: null,
          p_notes: 'Package size edited via student profile',
        })

        if (rpcError) {
          const msg = (rpcError.message || '').toLowerCase()
          if (msg.includes('total_below_consumed')) {
            return NextResponse.json(
              { error: 'New package total cannot be below the hours already used.' },
              { status: 400 }
            )
          }
          if (msg.includes('invalid_amount')) {
            return NextResponse.json(
              { error: 'Package total must be greater than zero.' },
              { status: 400 }
            )
          }
          console.error('adjust_hours_atomic (set_total) error:', rpcError)
          return NextResponse.json({ error: 'Failed to update training.' }, { status: 500 })
        }
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

    if ((parsed.data.status === 'former' || parsed.data.status === 'on_hold') && current.auth_user_id) {
      // Archiving must remove ALL access, not just current sessions. signOut
      // alone leaves the password valid, so a former student could log straight
      // back in. Ban the auth user first (locks login), then kill live sessions
      // — so sessions die only after the login is already locked. The ban is
      // lifted again when status returns to 'current' below.
      try {
        await adminClient.auth.admin.updateUserById(current.auth_user_id, { ban_duration: '876000h' })
      } catch (banError) {
        // The ban is the security-critical half: if it throws, the login is NOT
        // locked. Hard-fail with 500 rather than returning success — otherwise we
        // re-open the exact hole this block closes (a former student logging back
        // in). The admin retries; the status is already written so re-running is
        // idempotent. signOut below is skipped, but is moot until the ban lands.
        console.error('[archive student] ban failed:', banError)
        return NextResponse.json(
          { error: 'Failed to revoke student access. Please retry.' },
          { status: 500 }
        )
      }
      try {
        await adminClient.auth.admin.signOut(current.auth_user_id, 'global')
      } catch (signOutError) {
        console.error('[archive student] signOut failed:', signOutError)
      }
    } else if (parsed.data.status === 'current' && current.auth_user_id) {
      // Reinstating a student must restore login by lifting any prior ban.
      try {
        await adminClient.auth.admin.updateUserById(current.auth_user_id, { ban_duration: 'none' })
      } catch (unbanError) {
        console.error('[reactivate student] unban failed:', unbanError)
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

    const user = await requireAdmin()
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

    // 2b. Dual-identity preflight — if this student also has a profiles row
    // (auth_user_id doubles as profiles.id), that profile may own study
    // sheets. Deleting the profiles row in step 3m CASCADEs
    // study_sheets.owner_id and everything under those sheets. Owned sheets
    // must never be destroyed by a student purge — block, mirroring the
    // teacher purge preflight.
    if (student.auth_user_id) {
      const { count: ownedSheetCount, error: sheetCountError } = await adminClient
        .from('study_sheets')
        .select('owner_id', { count: 'exact', head: true })
        .eq('owner_id', student.auth_user_id)

      // Fail closed: an errored (or null) count is unknown, never zero.
      if (sheetCountError || ownedSheetCount === null) {
        console.error('[purge student] study_sheets preflight failed:', sheetCountError)
        return NextResponse.json(
          { error: 'Failed to verify owned study sheets. Purge aborted; nothing was deleted.' },
          { status: 500 }
        )
      }
      if (ownedSheetCount > 0) {
        return NextResponse.json(
          {
            error: 'Cannot purge: this account owns study sheets. Reassign or delete them first.',
            blocking: [{ table: 'study_sheets', count: ownedSheetCount }],
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
      await adminClient.from('reports').delete().in('lesson_id', lessonIds)
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
      // Dual-identity cleanup: no auth.users trigger exists (verified live
      // 15 Jul 2026) — a profiles row is present only when this account was
      // also given a staff identity. Delete it if present (no-op otherwise).
      // Owned study sheets are guaranteed absent by the step 2b preflight,
      // so this delete CASCADE-destroys nothing protected.
      await adminClient.from('profiles').delete().eq('id', authUserId)
      // Invalidate all active sessions for this user before deletion.
      // signOut with global scope kills every refresh token across every device.
      // Wrapped in try/catch and non-fatal — if signOut fails for any reason,
      // we still proceed with deleteUser to ensure the account is removed.
      try {
        await adminClient.auth.admin.signOut(authUserId, 'global')
      } catch (signOutError) {
        console.error('[purge student] signOut failed but proceeding with delete:', signOutError)
      }
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
