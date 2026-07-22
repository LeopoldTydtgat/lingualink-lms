import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TeacherReviewSchema } from '@/lib/validation/activities'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'

// POST /api/teacher/attempts/[attemptId]/review
// Saves a teacher's feedback on a writing_task attempt and clears its
// needs_review flag (NEW345 step 5). Authorisation mirrors the C3 responses
// page: teacher OR admin, with non-admins gated in JS by their Condition-B
// student set — the activity_attempts RLS teacher policy is deliberately not
// relied on (its trainings scope diverges from Condition B), and all writes to
// the table are service_role only anyway.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  try {
    const { attemptId } = await params

    // A non-uuid path segment can never name a row, and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!z.string().uuid().safeParse(attemptId).success) {
      return NextResponse.json({ error: 'Attempt not found' }, { status: 404 })
    }

    const supabase = await createClient()

    // ── 1. Authenticated user ────────────────────────────────────────────────
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // ── 2. Authorise: teacher OR admin ───────────────────────────────────────
    // Same isAdmin derivation as the C3 responses page (mirrors requireAdmin.ts).
    // A missing profile cannot be authorised — fail closed, never treat it as
    // unauthenticated.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const isAdmin = profile.role === 'admin'
    if (profile.role !== 'teacher' && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── 3. Validate the feedback body ────────────────────────────────────────
    // A malformed/absent JSON body fails safeParse → 400, never a 500.
    const body = await req.json().catch(() => null)
    const parsedBody = TeacherReviewSchema.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsedBody.error.flatten() },
        { status: 400 }
      )
    }
    const feedback = parsedBody.data.feedback.trim()

    const admin = createAdminClient()

    // ── 4. The attempt must exist ────────────────────────────────────────────
    const { data: attempt, error: attemptError } = await admin
      .from('activity_attempts')
      .select('id, student_id, activity_id, needs_review')
      .eq('id', attemptId)
      .maybeSingle()

    if (attemptError) {
      console.error('activity_attempts read error:', attemptId, attemptError)
      return NextResponse.json({ error: 'Failed to save your feedback' }, { status: 500 })
    }
    if (!attempt) {
      return NextResponse.json({ error: 'Attempt not found' }, { status: 404 })
    }

    // ── 5. Teacher-of-student gate (Condition B) ─────────────────────────────
    // A non-admin may only review attempts by their booked-class students.
    // Out-of-scope is a 404, not a 403 — never confirm the attempt exists.
    if (!isAdmin) {
      const scopedStudentIds = await getTeacherScopedStudentIds(admin, user.id, false)
      if (scopedStudentIds === null || !scopedStudentIds.includes(attempt.student_id)) {
        return NextResponse.json({ error: 'Attempt not found' }, { status: 404 })
      }
    }

    // ── 6. Only a writing_task is reviewable here ────────────────────────────
    // MCQ feedback is out of scope for this endpoint. An attempt whose activity
    // vanished cannot happen under the FK cascade, but fail closed regardless.
    const { data: activity, error: activityError } = await admin
      .from('activities')
      .select('id, type')
      .eq('id', attempt.activity_id)
      .maybeSingle()

    if (activityError) {
      console.error('activities read error:', attempt.activity_id, activityError)
      return NextResponse.json({ error: 'Failed to save your feedback' }, { status: 500 })
    }
    if (!activity) {
      return NextResponse.json({ error: 'Attempt not found' }, { status: 404 })
    }
    if (activity.type !== 'writing_task') {
      return NextResponse.json(
        { error: 'Only writing task responses can be reviewed here.' },
        { status: 422 }
      )
    }

    // ── 7. Persist the review ────────────────────────────────────────────────
    // toISOString is fine here: graded_at is a timestamptz instant, not a
    // local-date construction. reviewed_by references profiles(id), which IS
    // the auth uuid for staff.
    const { error: updateError } = await admin
      .from('activity_attempts')
      .update({
        teacher_feedback: feedback,
        reviewed_by: user.id,
        graded_at: new Date().toISOString(),
        needs_review: false,
      })
      .eq('id', attemptId)

    if (updateError) {
      console.error('activity_attempts update error:', attemptId, updateError)
      return NextResponse.json({ error: 'Failed to save your feedback' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('attempt review route error:', err)
    return NextResponse.json({ error: 'Failed to save your feedback' }, { status: 500 })
  }
}
