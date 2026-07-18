import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/student/assignments/[id]/mark-done
// Marks a whole assignment done at the sheet level - the completion path for a
// study sheet that has zero activities and so can never register completion via
// an activity attempt. Deliberately mirrors the submit-writing route's auth /
// authorisation chain step-for-step. assignments carries no RLS UPDATE policy,
// so the write goes through the admin client, gated by an explicit code-side
// ownership chain (student resolution -> assignment ownership -> sheet gate).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // A non-uuid path segment can never name a row, and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })
    }

    const supabase = await createClient()

    // -- 1. Authenticated user ------------------------------------------------
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // -- 2. Resolve the student -----------------------------------------------
    // auth_user_id is the only indirection from auth.users to students - the
    // auth uid is never a students PK.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    if (!student) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // -- 3. Fetch the assignment through the ADMIN client ---------------------
    // assignments has no student-facing RLS SELECT policy scoped for this write
    // path, so the row is read with the service-role client and every ownership
    // condition is enforced in code below.
    const admin = createAdminClient()

    const { data: assignment, error: assignmentError } = await admin
      .from('assignments')
      .select('id, student_id, study_sheet_id, marked_done_at')
      .eq('id', id)
      .maybeSingle()

    if (assignmentError) {
      console.error('assignments read error:', id, assignmentError)
      return NextResponse.json({ error: 'Failed to mark as done' }, { status: 500 })
    }
    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })
    }

    // -- 4. Ownership ---------------------------------------------------------
    // 404, not 403 - never confirm the existence of another student's
    // assignment. Same convention as the teacher review route.
    if (assignment.student_id !== student.id) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })
    }

    // -- 5. The sheet must be student-facing ----------------------------------
    // study_sheets SELECT policies are permissive (OR'd): a dual-identity user
    // holding both a profiles row and a students row sees the union of the
    // student and teacher tiers. Without this check such a user could mark done
    // an assignment against a staff-audience sheet. Mirrors the explicit
    // audience scoping in the submit-writing route.
    const { data: sheet, error: sheetError } = await supabase
      .from('study_sheets')
      .select('id')
      .eq('id', assignment.study_sheet_id)
      .eq('is_active', true)
      .eq('audience', 'student')
      .maybeSingle()

    if (sheetError) {
      console.error('study_sheets read error:', assignment.study_sheet_id, sheetError)
      return NextResponse.json({ error: 'Failed to mark as done' }, { status: 500 })
    }
    if (!sheet) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })
    }

    // -- 6. Idempotency -------------------------------------------------------
    // If already marked done, report success without writing - never overwrite
    // the original completion timestamp.
    if (assignment.marked_done_at) {
      return NextResponse.json({ success: true, alreadyDone: true })
    }

    // -- 7. Persist the completion --------------------------------------------
    // Writes to assignments are service-role only. toISOString() is banned for
    // LOCAL DATE construction in this project; here it produces a UTC instant
    // for a timestamptz column, which is the correct usage.
    const { error: updateError } = await admin
      .from('assignments')
      .update({ marked_done_at: new Date().toISOString() })
      .eq('id', assignment.id)

    if (updateError) {
      console.error('assignments update error:', assignment.id, updateError)
      return NextResponse.json({ error: 'Failed to mark as done' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('assignment mark-done route error:', err)
    return NextResponse.json({ error: 'Failed to mark as done' }, { status: 500 })
  }
}
