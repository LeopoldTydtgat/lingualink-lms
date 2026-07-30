import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { UpdateStudentSchema } from '@/lib/validation/schemas'

const UuidSchema = z.string().uuid()

// ─── PATCH — update student ───────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    if (!UuidSchema.safeParse(id).success) {
      return NextResponse.json({ error: 'Invalid student id.' }, { status: 400 })
    }

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

    // Rule: a training-side field arriving with a null training_id is a
    // client/data mismatch and must 400, never be silently dropped. Every
    // training block below is gated on `if (training_id && ...)`, so without
    // this guard those fields would be discarded while the route still returned
    // success. Uses the same `in` presence convention as the student payload
    // below, and runs before ANY write so a rejected request mutates nothing.
    //
    // This list is the IDOR gate for ALL training-side writes in this handler —
    // any new writable training column added to UpdateStudentSchema MUST be
    // added here, or its write path bypasses the ownership guard below.
    const TRAINING_FIELD_KEYS = ['package_name', 'total_hours', 'end_date', 'assigned_teacher_ids'] as const
    const trainingFieldsPresent = TRAINING_FIELD_KEYS.some((k) => k in parsed.data)

    if (trainingFieldsPresent && !training_id) {
      return NextResponse.json(
        { error: 'This student has no active training. Create a training before editing training details.' },
        { status: 400 }
      )
    }

    // This is the SINGLE ownership check protecting every training-side write
    // below. training_id is client-supplied, and training_teachers has no
    // student_id column, so those writes cannot be scoped per-query — this
    // guard is what proves the training belongs to the student in the URL.
    // It runs before any write, so a mismatched training_id mutates nothing.
    if (training_id && trainingFieldsPresent) {
      const { data: ownedTraining, error: ownershipError } = await adminClient
        .from('trainings')
        .select('id')
        .eq('id', training_id)
        .eq('student_id', id)
        .maybeSingle()

      // A transient DB failure is NOT a missing row. Collapsing the two into one
      // 404 tells the admin the training is gone and invites them to create a
      // duplicate, with nothing in the logs. Fail loud and distinct.
      if (ownershipError) {
        console.error('Training ownership check error (student PATCH):', ownershipError)
        return NextResponse.json({ error: 'Failed to verify training.' }, { status: 500 })
      }

      if (!ownedTraining) {
        return NextResponse.json(
          { error: 'Training record not found for this student.' },
          { status: 404 }
        )
      }
    }

    // Deduped because the body could repeat an id, which would double-insert the
    // join row below (or trip its (training_id, teacher_id) PK). Lowercased
    // because z.string().uuid() accepts uppercase while Postgres returns
    // lowercase: without normalising, a mixed-case pair survives the dedupe and
    // the allowed-set comparison below can 400 a teacher that is genuinely
    // assignable. Computed once here and reused by the write block further down.
    const submittedTeacherIds = Array.isArray(assigned_teacher_ids)
      ? [...new Set(assigned_teacher_ids.map((tid) => tid.toLowerCase()))]
      : []

    // The ownership check above proves the training belongs to this student,
    // but says nothing about WHO may be attached to it. assigned_teacher_ids
    // is raw client input and training_teachers is the messaging/access
    // junction, so an unvalidated uuid here grants an arbitrary profile — a
    // student, an archived teacher — a live access edge to this student.
    //
    // The allowed set mirrors the edit page's teachers query
    // (src/app/(admin)/admin/students/[id]/edit/page.tsx:109-114 —
    // role in ('teacher','admin') AND status = 'current'). That filter is the
    // canonical definition of an assignable teacher; this gate must not
    // diverge from it, or the form offers picks the route rejects.
    //
    // The union with ids ALREADY on this training exists because the edit page
    // deliberately backfills an assigned profile that has since been archived
    // (page.tsx:120-142) so the admin can see and remove it — the form re-sends
    // that id on every save. Without the union, an unrelated profile edit would
    // 400. A newly added archived/invalid id is still rejected: it is in
    // neither half of the set.
    //
    // The gate is placed here, ahead of the first write in the handler: both of
    // its reads depend on nothing written below, so a rejected request mutates
    // nothing at all — not the students row, not the training, not the hours
    // ledger, not training_teachers.
    // The edit form already blocks an empty selection (EditStudentClient.tsx:242),
    // but that is a client guard only — a raw PATCH with [] would strip every
    // teacher off the training. Rejecting here means no write has happened yet.
    if (training_id && Array.isArray(assigned_teacher_ids) && submittedTeacherIds.length === 0) {
      return NextResponse.json(
        { error: 'At least one teacher must be assigned.' },
        { status: 400 }
      )
    }

    if (training_id && Array.isArray(assigned_teacher_ids) && submittedTeacherIds.length > 0) {
      const { data: assignable, error: assignableError } = await adminClient
        .from('profiles')
        .select('id')
        .in('id', submittedTeacherIds)
        .in('role', ['teacher', 'admin'])
        .eq('status', 'current')

      // A failed read is neither "none of these are assignable" (which would
      // 400 a legitimate save) nor "all of them are" (which would re-open the
      // hole). Fail loud, same split as the ownership check above.
      if (assignableError || !assignable) {
        console.error('Assignable-teacher lookup error (student PATCH):', assignableError)
        return NextResponse.json(
          { error: 'Failed to verify the selected teachers.' },
          { status: 500 }
        )
      }

      const { data: alreadyAssigned, error: alreadyAssignedError } = await adminClient
        .from('training_teachers')
        .select('teacher_id')
        .eq('training_id', training_id)

      if (alreadyAssignedError || !alreadyAssigned) {
        console.error('Existing training_teachers lookup error (student PATCH):', alreadyAssignedError)
        return NextResponse.json(
          { error: 'Failed to verify the current teacher assignments.' },
          { status: 500 }
        )
      }

      const allowedTeacherIds = new Set<string>([
        ...(assignable as { id: string }[]).map((p) => p.id),
        ...(alreadyAssigned as { teacher_id: string | null }[])
          .map((r) => r.teacher_id)
          .filter((tid): tid is string => Boolean(tid)),
      ])

      if (submittedTeacherIds.some((tid) => !allowedTeacherIds.has(tid))) {
        return NextResponse.json(
          { error: 'One or more selected teachers are not assignable.' },
          { status: 400 }
        )
      }
    }

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
        .eq('student_id', id)

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

    // Every id reaching these writes has already cleared the assignability gate
    // above, which ran before the first write in the handler.
    if (training_id && Array.isArray(assigned_teacher_ids)) {
      // Atomic delta swap in a single transaction: the training row is locked,
      // only ids leaving the set are deleted and only ids not already present are
      // inserted. So unchanged teachers keep their original assigned_at, and there
      // is no window in which the training has zero assigned teachers. SECURITY
      // DEFINER with EXECUTE granted to service_role only — must be adminClient.
      const { error: swapError } = await adminClient.rpc('swap_training_teachers', {
        p_training_id: training_id,
        p_teacher_ids: submittedTeacherIds,
      })

      if (swapError) {
        const msg = swapError.message || ''

        // Unreachable via the guard above; kept so the RPC's own rejection still
        // maps to the same 400 if another path ever reaches it with an empty set.
        if (msg.includes('empty_teacher_set')) {
          return NextResponse.json(
            { error: 'At least one teacher must be assigned.' },
            { status: 400 }
          )
        }

        if (msg.includes('training_not_found')) {
          return NextResponse.json({ error: 'Training not found.' }, { status: 404 })
        }

        console.error('swap_training_teachers error:', swapError)
        return NextResponse.json({ error: 'Failed to update assigned teachers.' }, { status: 500 })
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

// Shape returned by public.purge_student_atomic on success.
type PurgeStudentResult = {
  success: boolean
  auth_user_id: string | null
  deleted: Record<string, number>
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    if (!UuidSchema.safeParse(id).success) {
      return NextResponse.json({ error: 'Invalid student id.' }, { status: 400 })
    }

    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Unauthorised or Forbidden' }, { status: 401 })

    const adminClient = createAdminClient()

    // Every table delete — messages, support_messages, lessons, students and
    // the dual-identity profiles row — happens inside purge_student_atomic
    // (SECURITY DEFINER), together with the fail-closed preflights. The route
    // owns nothing but the auth.users cleanup below: a partial purge is not
    // possible any more, because the RPC is a single transaction.
    const { data, error } = await adminClient.rpc('purge_student_atomic', {
      p_student_id: id,
    })

    if (error) {
      const message = error.message || ''

      if (error.code === 'P0002') {
        return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
      }

      if (error.code === 'P0001') {
        if (message.startsWith('student_not_former')) {
          return NextResponse.json(
            { error: 'Student must be archived (status: former) before purging.' },
            { status: 409 }
          )
        }

        if (message.startsWith('teachers_not_former:')) {
          const names = message.slice('teachers_not_former:'.length).trim()
          const blockedBy = names ? names.split(', ').map((n) => n.trim()).filter(Boolean) : []
          return NextResponse.json(
            {
              error: 'Cannot purge: the following teachers must be archived first.',
              blockedBy,
            },
            { status: 409 }
          )
        }

        if (message.startsWith('dual_identity_blocked:')) {
          const payload = message.slice('dual_identity_blocked:'.length).trim()
          let blocking: unknown[] = []
          try {
            const parsedPayload = JSON.parse(payload)
            blocking = Array.isArray(parsedPayload) ? parsedPayload : []
          } catch (parseError) {
            // The raw message never reaches the client — it is diagnostic only.
            console.error('purge_student_atomic dual_identity_blocked parse failed:', parseError, message)
            blocking = []
          }
          return NextResponse.json(
            {
              error: 'Cannot purge: this account also holds staff-side data. Resolve the blocking records first.',
              blocking,
            },
            { status: 409 }
          )
        }
      }

      // Includes students_delete_failed and anything unmapped. The RPC is
      // transactional, so an error here means nothing was deleted.
      console.error('purge_student_atomic error:', error)
      return NextResponse.json({ error: 'Purge failed. Nothing was deleted.' }, { status: 500 })
    }

    const result = data as PurgeStudentResult

    // The auth id comes from the row the RPC locked and deleted — never from a
    // separate pre-read, which could race the purge.
    const authUserId = result.auth_user_id
    if (authUserId) {
      // Non-fatal: the account is about to be deleted anyway.
      try {
        await adminClient.auth.admin.signOut(authUserId, 'global')
      } catch (signOutError) {
        console.error('[purge student] signOut failed but proceeding with delete:', signOutError)
      }

      const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(authUserId)
      if (authDeleteError) {
        // NOT a silent success: the DB rows are already gone, so retrying this
        // route returns 404. The admin needs the auth id to finish by hand.
        console.error('[purge student] auth user delete failed:', authDeleteError)
        return NextResponse.json(
          {
            error: 'Student data was purged, but the login account could not be deleted. Remove it manually in Supabase Auth.',
            auth_user_id: authUserId,
          },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true, deleted: result.deleted })
  } catch (err) {
    console.error('DELETE student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
