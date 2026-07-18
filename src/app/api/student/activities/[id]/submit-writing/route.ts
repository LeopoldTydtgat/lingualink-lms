import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  WritingTaskContentSchema,
  WritingTaskSubmissionSchema,
} from '@/lib/validation/activities'

// POST /api/student/activities/[id]/submit-writing
// Records a student's free-text response to a writing_task activity. Deliberately
// mirrors the MCQ grade route's auth/authorisation chain step-for-step; it only
// diverges where a writing task differs from an auto-graded one: there is no
// answer key to read and no grading — the attempt is stored unscored and flagged
// for teacher review.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // A non-uuid path segment can never name a row, and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    const supabase = await createClient()

    // ── 1. Authenticated user ────────────────────────────────────────────────
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // ── 2. Resolve the student ───────────────────────────────────────────────
    // auth_user_id is the only indirection from auth.users to students — the
    // auth uid is never a students PK.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    if (!student) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── 3. Validate the submission ───────────────────────────────────────────
    // A malformed/absent JSON body fails safeParse → 400, never a 500.
    const body = await req.json().catch(() => null)
    const parsedBody = WritingTaskSubmissionSchema.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsedBody.error.flatten() },
        { status: 400 }
      )
    }
    const { response_text: responseText, assignment_id: assignmentId } = parsedBody.data

    // ── 4. Fetch the activity through the USER-SCOPED client ─────────────────
    // RLS restricts activities to sheets this user can see. Never the admin
    // client here — that would bypass the visibility check that authorises the
    // whole request.
    const { data: activity, error: activityError } = await supabase
      .from('activities')
      .select('id, sheet_id, type, content')
      .eq('id', id)
      .maybeSingle()

    // maybeSingle() reports the invisible-row case as {data: null, error: null},
    // so a non-null error is a genuine fault — never a "not found".
    if (activityError) {
      console.error('activities read error:', id, activityError)
      return NextResponse.json({ error: 'Failed to submit your response' }, { status: 500 })
    }
    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    // ── 5. The sheet must be student-facing ──────────────────────────────────
    // study_sheets SELECT policies are permissive (OR'd): a dual-identity user
    // holding both a profiles row and a students row sees the union of the
    // student and teacher tiers. Without this check such a user could submit
    // against a staff-audience activity. Mirrors the explicit audience scoping
    // in student/study/[id]/page.tsx and the grade route.
    const { data: sheet, error: sheetError } = await supabase
      .from('study_sheets')
      .select('id')
      .eq('id', activity.sheet_id)
      .eq('is_active', true)
      .eq('audience', 'student')
      .maybeSingle()

    if (sheetError) {
      console.error('study_sheets read error:', activity.sheet_id, sheetError)
      return NextResponse.json({ error: 'Failed to submit your response' }, { status: 500 })
    }
    if (!sheet) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    // ── 6. This endpoint accepts a writing_task only ─────────────────────────
    if (activity.type !== 'writing_task') {
      return NextResponse.json(
        { error: 'This activity does not accept a written response.' },
        { status: 422 }
      )
    }

    // ── 7. Authored content must be well-formed ──────────────────────────────
    // Malformed content is an authoring problem, not the student's — 500.
    const parsedContent = WritingTaskContentSchema.safeParse(activity.content)
    if (!parsedContent.success) {
      console.error('Malformed writing_task content:', id, parsedContent.error.issues)
      return NextResponse.json({ error: 'Failed to submit your response' }, { status: 500 })
    }

    const admin = createAdminClient()

    // ── 8. A client-supplied assignment_id must belong to this student ───────
    if (assignmentId) {
      // The assignment must target this activity's sheet — otherwise a student
      // could stamp any of their assignments onto any attempt.
      const { data: assignment, error: assignmentError } = await admin
        .from('assignments')
        .select('id')
        .eq('id', assignmentId)
        .eq('student_id', student.id)
        .eq('study_sheet_id', activity.sheet_id)
        .maybeSingle()

      if (assignmentError) {
        console.error('assignment ownership check error:', assignmentId, assignmentError)
        return NextResponse.json({ error: 'Failed to submit your response' }, { status: 500 })
      }
      if (!assignment) {
        return NextResponse.json({ error: 'Invalid assignment.' }, { status: 400 })
      }
    }

    // ── 9. Persist the attempt ───────────────────────────────────────────────
    // Writes to activity_attempts are service_role only. A writing task is not
    // auto-graded: score and graded_at stay null and needs_review flags it for a
    // teacher. The table is append-only — each submission is a new row.
    const { error: insertError } = await admin.from('activity_attempts').insert({
      student_id: student.id,
      activity_id: id,
      assignment_id: assignmentId ?? null,
      answers: { response_text: responseText.trim() },
      score: null,
      needs_review: true,
      graded_at: null,
    })

    if (insertError) {
      console.error('activity_attempts insert error:', id, insertError)
      return NextResponse.json({ error: 'Failed to save your response' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('activity submit-writing route error:', err)
    return NextResponse.json({ error: 'Failed to submit your response' }, { status: 500 })
  }
}
