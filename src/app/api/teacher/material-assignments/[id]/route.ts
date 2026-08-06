import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const UuidSchema = z.string().uuid()

// DELETE /api/teacher/material-assignments/[id]
//
// SEMANTIC REVOKE - stamps revoked_at, never deletes the row. The grant row is
// also the student's homework layer (annotations jsonb), so deleting it would
// destroy their work; and the row is the audit trail of what was handed out.
//
// AUTHORISATION MODEL - the write and the check are deliberately split:
//   - Teachers hold only `grant update (annotations, updated_at)` on this table,
//     so revoked_at CANNOT be written by the user-scoped client. The UPDATE runs
//     on the service-role client.
//   - Service role bypasses RLS, so this route must do the relationship check
//     itself FIRST, and it does it the only way that cannot drift from the live
//     policy: a user-scoped SELECT of the row. The material_assignments SELECT
//     policies (teacher -> students they teach, admin -> all) ARE the check. A
//     row this caller cannot read is a 404, indistinguishable from "no such
//     assignment", so nothing leaks.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let assignmentId = ''
  try {
    ;({ id: assignmentId } = await params)

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

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
