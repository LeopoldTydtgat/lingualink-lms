import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { CreateTrainingSchema } from '@/lib/validation/schemas'

const UuidSchema = z.string().uuid()

// ─── POST — create a training for a student who has none active ───────────────
//
// The whole write (active-training check, trainings insert, training_teachers
// rows) happens inside create_training_atomic, which serialises concurrent calls
// on the students row lock. This route owns only the authorisation, the input
// validation and the teacher-assignability gate; it performs no writes of its
// own, so a rejection here leaves nothing to roll back.
//
// Deliberately NO opening hours_log row: the RPC does not write one and neither
// does this route. Locked decision — the ledger records adjustments to a
// training's balance, not the package the training was created with, and the
// create-student route behaves the same way.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ── 1. Verify admin ──────────────────────────────────────────────────────
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: studentId } = await params

    // ── 2. Validate the studentId URL param is a UUID ────────────────────────
    if (!UuidSchema.safeParse(studentId).success) {
      return NextResponse.json({ error: 'Invalid student ID.' }, { status: 400 })
    }

    const body = await req.json()

    // ── 3. Validate the request body ─────────────────────────────────────────
    const parsed = CreateTrainingSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const data = parsed.data

    const adminClient = createAdminClient()

    // ── 4. Validate the submitted teacher assignments ────────────────────────
    // Deduped because the body could repeat an id (the RPC's ON CONFLICT DO
    // NOTHING is only a backstop). Lowercased because z.string().uuid() accepts
    // uppercase while Postgres returns lowercase: without normalising, a
    // mixed-case pair survives the dedupe and the allowed-set comparison below
    // would reject a teacher that is genuinely assignable. Computed once and
    // handed to the RPC, so the ids that were validated are exactly the ids
    // that get inserted.
    const submittedTeacherIds = [
      ...new Set(data.teacher_ids.map((tid: string) => tid.toLowerCase())),
    ]

    // teacher_ids is raw client input and training_teachers is the
    // messaging/access junction, so an unvalidated uuid here would hand an
    // arbitrary profile — a student, an archived teacher — a live access edge to
    // this student. The allowed set is copied VERBATIM from the create-student
    // route (src/app/api/admin/students/route.ts, the assignable-teacher
    // gate ahead of the first mutation — profiles where
    // role in ('teacher','admin') AND status = 'current'), which in turn mirrors
    // the create form's teachers query. That filter is the canonical definition
    // of an assignable teacher; this gate must not diverge from it, or the form
    // offers picks the route rejects.
    //
    // Like create-student and unlike the student PATCH gate, there is NO union
    // with ids already on the training: the training does not exist yet, so
    // there is nothing to grandfather in.
    //
    // An EMPTY set is allowed by design — a training with no teachers is a valid
    // intermediate state — so this block is skipped rather than rejected.
    if (submittedTeacherIds.length > 0) {
      const { data: assignable, error: assignableError } = await adminClient
        .from('profiles')
        .select('id')
        .in('id', submittedTeacherIds)
        .in('role', ['teacher', 'admin'])
        .eq('status', 'current')

      // A failed read is neither "none of these are assignable" (which would
      // reject a legitimate create) nor "all of them are" (which would re-open
      // the hole). Fail loud.
      if (assignableError || !assignable) {
        console.error('Assignable-teacher lookup error (training POST):', assignableError)
        return NextResponse.json(
          { error: 'Failed to verify the selected teachers.' },
          { status: 500 }
        )
      }

      const allowedTeacherIds = new Set<string>(
        (assignable as { id: string }[]).map((p) => p.id)
      )

      const rejectedTeacherIds = submittedTeacherIds.filter(
        (tid) => !allowedTeacherIds.has(tid)
      )

      if (rejectedTeacherIds.length > 0) {
        return NextResponse.json(
          {
            error: `One or more selected teachers are not assignable: ${rejectedTeacherIds.join(', ')}`,
            invalidTeacherIds: rejectedTeacherIds,
          },
          { status: 422 }
        )
      }
    }

    // ── 5. Create the training atomically ────────────────────────────────────
    // SECURITY DEFINER with EXECUTE granted to service_role only — this MUST be
    // the admin client; the RLS-bound session client gets permission denied.
    const { data: trainingId, error: rpcError } = await adminClient.rpc(
      'create_training_atomic',
      {
        p_student_id: studentId,
        p_package_name: data.package_name,
        p_total_hours: data.total_hours,
        p_end_date: data.end_date ?? null,
        p_teacher_ids: submittedTeacherIds,
      }
    )

    if (rpcError) {
      const msg = rpcError.message || ''

      // Raised by the RPC after its student-row lock, so this is authoritative
      // even against a concurrent create.
      if (msg.includes('active_training_exists')) {
        return NextResponse.json(
          { error: 'This student already has an active training.' },
          { status: 409 }
        )
      }

      if (msg.includes('student_not_found')) {
        return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
      }

      if (msg.includes('invalid_total_hours')) {
        return NextResponse.json(
          { error: 'Total hours must be greater than zero.' },
          { status: 422 }
        )
      }

      // The one_active_training_per_student partial unique index is the DB-level
      // backstop for the same condition. Unreachable through this route (the RPC
      // serialises on the student row), but a write racing in from another path
      // must still read as the 409 it is, not an opaque 500.
      if (rpcError.code === '23505' && msg.includes('one_active_training_per_student')) {
        return NextResponse.json(
          { error: 'This student already has an active training.' },
          { status: 409 }
        )
      }

      // Raw Postgres text never reaches the client — it is diagnostic only.
      console.error('create_training_atomic error:', rpcError)
      return NextResponse.json(
        { error: 'Failed to create the training.' },
        { status: 500 }
      )
    }

    // The RPC returns the new training id and raises on every failure path, so a
    // null here means something unexpected happened. Fail loud rather than
    // reporting a success the caller cannot act on.
    if (!trainingId) {
      console.error('create_training_atomic returned no training id for student:', studentId)
      return NextResponse.json(
        { error: 'Failed to create the training.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, training_id: trainingId })
  } catch (err) {
    console.error('Create training error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
