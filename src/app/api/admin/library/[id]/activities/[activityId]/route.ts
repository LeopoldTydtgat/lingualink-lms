import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { McqActivityAuthorSchema } from '@/lib/validation/activities'

const ACTIVITY_LIST_COLUMNS = 'id, sheet_id, position, type, title, content, created_at, updated_at'

// GET /api/admin/library/[id]/activities/[activityId]
// The ONLY route that returns answer_key. It exists to populate the admin
// builder form — an admin authoring an activity necessarily sees its answers.
// Reached through the service-role client AFTER the admin gate above, because
// the `authenticated` column grant on activities excludes answer_key entirely
// (20260715120000_new345_library_owner_tags_activities.sql): no user-scoped
// query, browser client or otherwise, can read it.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; activityId: string }> }
) {
  const { id, activityId } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (
    !z.string().uuid().safeParse(id).success ||
    !z.string().uuid().safeParse(activityId).success
  ) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  // Scoped by BOTH ids: the activity must belong to the sheet in the path, so a
  // mismatched pair reads as "not found" rather than quietly serving another
  // sheet's activity (and its answer key).
  const { data, error } = await adminClient
    .from('activities')
    .select('id, sheet_id, position, type, title, content, answer_key, created_at, updated_at')
    .eq('id', activityId)
    .eq('sheet_id', id)
    .maybeSingle()

  if (error) {
    console.error('admin activity read error:', activityId, error)
    return NextResponse.json({ error: 'Could not load the activity.' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  return NextResponse.json(data)
}

// PATCH /api/admin/library/[id]/activities/[activityId] — edit an MCQ activity
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; activityId: string }> }
) {
  const { id, activityId } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (
    !z.string().uuid().safeParse(id).success ||
    !z.string().uuid().safeParse(activityId).success
  ) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = McqActivityAuthorSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid activity data.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { title, content, answer_key } = parsed.data

  const adminClient = createAdminClient()

  // Ownership: the activity must belong to this sheet before anything is written.
  const { data: existing, error: existingError } = await adminClient
    .from('activities')
    .select('id, type')
    .eq('id', activityId)
    .eq('sheet_id', id)
    .maybeSingle()

  if (existingError) {
    console.error('admin activity update — ownership read error:', activityId, existingError)
    return NextResponse.json({ error: 'Could not save the activity.' }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  // This body is validated as MCQ. Writing it over a gap_fill (or any other
  // type) would leave content the player for that type cannot read.
  if (existing.type !== 'mcq') {
    return NextResponse.json(
      { error: 'This activity is not a multiple-choice activity and cannot be edited here.' },
      { status: 422 }
    )
  }

  // activities has no updated_at trigger — the column is maintained here.
  const { data, error } = await adminClient
    .from('activities')
    .update({
      title: title.trim(),
      content,
      answer_key,
      updated_at: new Date().toISOString(),
    })
    .eq('id', activityId)
    .eq('sheet_id', id)
    .select(ACTIVITY_LIST_COLUMNS)
    .single()

  if (error) {
    console.error('admin activity update error:', activityId, error)
    return NextResponse.json({ error: 'Could not save the activity.' }, { status: 500 })
  }

  return NextResponse.json(data)
}

// DELETE /api/admin/library/[id]/activities/[activityId]
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; activityId: string }> }
) {
  const { id, activityId } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (
    !z.string().uuid().safeParse(id).success ||
    !z.string().uuid().safeParse(activityId).success
  ) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  const { data: existing, error: existingError } = await adminClient
    .from('activities')
    .select('id')
    .eq('id', activityId)
    .eq('sheet_id', id)
    .maybeSingle()

  if (existingError) {
    console.error('admin activity delete — ownership read error:', activityId, existingError)
    return NextResponse.json({ error: 'Could not delete the activity.' }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Activity not found.' }, { status: 404 })
  }

  // activity_attempts.activity_id is ON DELETE CASCADE
  // (20260715120000_new345_library_owner_tags_activities.sql), so the FK does NOT
  // block: deleting this row would silently destroy every graded student attempt
  // against it, with no warning and no undo. That is the same hazard the D4
  // decision refuses for teacher sheet deletes
  // (20260715180000_new345_teacher_write_policies.sql: a hard DELETE would
  // cascade lesson_annotations and exercise_completions). Attempted activities
  // are therefore blocked here rather than quietly cascaded.
  const { count, error: countError } = await adminClient
    .from('activity_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('activity_id', activityId)

  // Fail closed: an uncounted attempt table must never read as "no attempts".
  if (countError || count === null) {
    console.error('admin activity delete — attempts count error:', activityId, countError)
    return NextResponse.json({ error: 'Could not delete the activity.' }, { status: 500 })
  }

  if (count > 0) {
    return NextResponse.json(
      {
        error: `This activity has ${count} student ${count === 1 ? 'attempt' : 'attempts'}. Deleting it would erase that history, so it cannot be deleted.`,
        attempts: count,
      },
      { status: 409 }
    )
  }

  const { error } = await adminClient
    .from('activities')
    .delete()
    .eq('id', activityId)
    .eq('sheet_id', id)

  if (error) {
    console.error('admin activity delete error:', activityId, error)
    return NextResponse.json({ error: 'Could not delete the activity.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
