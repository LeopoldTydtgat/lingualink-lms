import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildExerciseRows } from '../exercises'

// PATCH /api/admin/library/[id] — update a study sheet
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()

  // Only allow fields that are safe to update — strip anything unexpected
  const allowed = ['title', 'category', 'level', 'difficulty', 'intro_text', 'content', 'allowed_roles', 'is_active', 'attachments', 'audience']
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  // Audience is an access boundary: accept only 'student' or 'staff'. Any other
  // value (or a malformed one) coerces to the fail-safe 'staff'. Absent = unchanged.
  if ('audience' in update) {
    update.audience = update.audience === 'student' ? 'student' : 'staff'
  }

  // Exercises live in the exercises table, never in study_sheets.content. When the
  // caller submits content (a full editor save), capture its exercises for the
  // table and blank content.exercises (words preserved). When content is absent
  // (e.g. the create flow's attachments-only PATCH), leave exercises untouched.
  const hasContent = 'content' in body
  let incomingExercises: unknown = undefined
  if (hasContent) {
    const contentObj: Record<string, unknown> =
      body.content && typeof body.content === 'object' && !Array.isArray(body.content)
        ? (body.content as Record<string, unknown>)
        : {}
    incomingExercises = contentObj.exercises
    update.content = {
      words: Array.isArray(contentObj.words) ? contentObj.words : [],
      exercises: [],
    }
  }

  update.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('study_sheets')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Replace this sheet's exercise rows so what was on screen becomes the saved
  // truth — but only when content was actually submitted. An attachments-only
  // PATCH (no content key) must NOT wipe the rows. Admin client: writes bypass
  // RLS, consistent with the create route.
  if (hasContent) {
    const adminClient = createAdminClient()

    const { error: deleteError } = await adminClient
      .from('exercises')
      .delete()
      .eq('study_sheet_id', id)

    if (deleteError) {
      return NextResponse.json(
        { error: `Sheet saved, but clearing its old exercises failed: ${deleteError.message}` },
        { status: 500 }
      )
    }

    const exerciseRows = buildExerciseRows(id, incomingExercises)
    if (exerciseRows.length > 0) {
      const { error: insertError } = await adminClient
        .from('exercises')
        .insert(exerciseRows)

      if (insertError) {
        return NextResponse.json(
          { error: `Sheet saved, but its exercises failed to save: ${insertError.message}` },
          { status: 500 }
        )
      }
    }
  }

  return NextResponse.json(data)
}

// DELETE /api/admin/library/[id] — delete a study sheet and its assignments
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const adminClient = createAdminClient()

  // Delete associated assignments first to avoid FK constraint violations
  await adminClient
    .from('assignments')
    .delete()
    .eq('study_sheet_id', id)

  const { error } = await adminClient
    .from('study_sheets')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
