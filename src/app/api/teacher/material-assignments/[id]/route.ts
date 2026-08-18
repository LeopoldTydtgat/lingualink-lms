import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireTeacher } from '@/lib/auth/requireTeacher'
import { requireStaff } from '@/lib/auth/requireStaff'

const UuidSchema = z.string().uuid()

// DELETE /api/teacher/material-assignments/[id]
//
// SEMANTIC REVOKE - stamps revoked_at, never deletes the row. The grant row is
// also the student's homework layer (annotations jsonb), so deleting it would
// destroy their work; and the row is the audit trail of what was handed out.
//
// AUTHORISATION MODEL - three separate questions, answered in this order:
//   1. MAY THIS ACTOR TYPE REVOKE AT ALL? An explicit role gate, admitting only
//      current teachers, staff and admins. This is required and cannot be
//      replaced by the read below: the material_assignments SELECT policies are
//      WIDER than the intended actor set - they also admit the STUDENT who owns
//      the row. A student passes a user-scoped read of their own assignment, so
//      the read alone would let them self-revoke their own homework grant and
//      free the partial-unique live slot. Read-policy-as-write-gate only holds
//      where the read set equals the write set, which is true for the POST on
//      the sibling route (its INSERT policy WITH CHECK is teacher-shaped) and
//      false here.
//   2. IS THIS ROW THEIRS? The user-scoped SELECT that follows is the
//      RELATIONSHIP check, kept because it cannot drift from the live policy:
//      the database answers, not a re-implementation of it here. A row this
//      caller cannot read is a 404, indistinguishable from "no such
//      assignment", so nothing leaks.
//   3. WHO WRITES? Teachers hold only `grant update (annotations, updated_at)`
//      on this table, so revoked_at CANNOT be written by the user-scoped
//      client. The UPDATE runs on the service-role client, after both checks.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let assignmentId = ''
  try {
    ;({ id: assignmentId } = await params)

    // Role gate. Teachers revoke from the assign modal; admins revoke from
    // the admin student detail page. requireTeacher is tried first because
    // it is the common caller. Both helpers apply status === 'current' and
    // both THROW on a failed profiles read rather than denying, so a
    // transient DB fault surfaces as a 500 from the outer catch and never as
    // a misleading 403.
    const teacherAuth = await requireTeacher()
    const staffUser = teacherAuth ? null : await requireStaff()
    if (!teacherAuth && !staffUser) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const supabase = teacherAuth ? teacherAuth.supabase : await createClient()

    // A non-uuid path segment can never name a row and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!UuidSchema.safeParse(assignmentId).success) {
      return NextResponse.json({ error: 'A valid assignment id is required.' }, { status: 400 })
    }

    // --- THE GATE: user-scoped read, RLS decides -----------------------------
    // Explicit column list, never select('*'): this table carries a
    // column-level UPDATE grant. maybeSingle - zero rows is the expected
    // "not yours / no such row" outcome, not an exception.
    const { data: assignment, error: lookupError } = await supabase
      .from('material_assignments')
      .select('id, student_id, revoked_at')
      .eq('id', assignmentId)
      .maybeSingle()

    if (lookupError) {
      console.error(
        `[teacher/material-assignments/[id]] lookup failed (assignment ${assignmentId}):`,
        lookupError
      )
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found.' }, { status: 404 })
    }
    if (assignment.revoked_at !== null) {
      return NextResponse.json(
        { error: 'This assignment has already been revoked.' },
        { status: 409 }
      )
    }

    // --- The write (service role, post-gate) ---------------------------------
    // toISOString is correct here: both columns are timestamptz instants, not
    // local-date constructions. `revoked_at is null` in the filter makes the
    // update idempotent against a concurrent revoke - the loser matches zero
    // rows and is reported as a 409 below, never as success.
    const nowIso = new Date().toISOString()
    const adminClient = createAdminClient()

    const { data: updated, error: updateError } = await adminClient
      .from('material_assignments')
      .update({ revoked_at: nowIso, updated_at: nowIso })
      .eq('id', assignmentId)
      .is('revoked_at', null)
      .select('id')

    if (updateError) {
      console.error(
        `[teacher/material-assignments/[id]] revoke failed (assignment ${assignmentId}):`,
        updateError
      )
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'This assignment has already been revoked.' },
        { status: 409 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error(
      `[teacher/material-assignments/[id]] unhandled failure (assignment ${assignmentId}):`,
      err
    )
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
