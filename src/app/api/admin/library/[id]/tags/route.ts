import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { SheetTagsPutSchema } from '@/lib/validation/tags'

// GET /api/admin/library/[id]/tags — the sheet's current tag ids
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  const { data, error } = await adminClient
    .from('sheet_tags')
    .select('tag_id')
    .eq('sheet_id', id)

  if (error) {
    console.error('admin sheet tags read error:', id, error)
    return NextResponse.json({ error: "Could not load this sheet's tags." }, { status: 500 })
  }

  return NextResponse.json({ tag_ids: (data ?? []).map(row => row.tag_id) })
}

// PUT /api/admin/library/[id]/tags — replace the sheet's entire tag set
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = SheetTagsPutSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid tag selection.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // The same tag twice in one request is the client's problem, not an error:
  // sheet_tags is keyed (sheet_id, tag_id), so the duplicate row would violate
  // the primary key.
  const tagIds = Array.from(new Set(parsed.data.tag_ids))

  const adminClient = createAdminClient()

  const { data: sheet, error: sheetError } = await adminClient
    .from('study_sheets')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (sheetError) {
    console.error('admin sheet tags — sheet read error:', id, sheetError)
    return NextResponse.json({ error: "Could not save this sheet's tags." }, { status: 500 })
  }
  if (!sheet) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  // Every tag must exist before anything is deleted. The FK would reject an
  // unknown id anyway, but only AFTER the delete below had already cleared the
  // old set — leaving the sheet with no tags at all.
  if (tagIds.length > 0) {
    const { data: foundTags, error: tagsError } = await adminClient
      .from('tags')
      .select('id')
      .in('id', tagIds)

    if (tagsError) {
      console.error('admin sheet tags — tag existence check error:', id, tagsError)
      return NextResponse.json({ error: "Could not save this sheet's tags." }, { status: 500 })
    }

    const found = new Set((foundTags ?? []).map(t => t.id))
    const missing = tagIds.filter(tagId => !found.has(tagId))
    if (missing.length > 0) {
      return NextResponse.json(
        { error: 'One or more of the selected tags no longer exist. Reload and try again.' },
        { status: 400 }
      )
    }
  }

  // Replace: clear the old set, then write the new one. Not atomic — a failure
  // between the two leaves the sheet untagged, which the error below reports so
  // the admin can retry rather than silently believing it saved. Mirrors the
  // established exercises replace in ../route.ts.
  const { error: deleteError } = await adminClient
    .from('sheet_tags')
    .delete()
    .eq('sheet_id', id)

  if (deleteError) {
    console.error('admin sheet tags — delete error:', id, deleteError)
    return NextResponse.json({ error: "Could not save this sheet's tags." }, { status: 500 })
  }

  if (tagIds.length > 0) {
    const { error: insertError } = await adminClient
      .from('sheet_tags')
      .insert(tagIds.map(tagId => ({ sheet_id: id, tag_id: tagId })))

    if (insertError) {
      console.error('admin sheet tags — insert error:', id, insertError)
      return NextResponse.json(
        { error: "This sheet's previous tags were cleared, but the new ones failed to save. Reopen the sheet and set them again." },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ tag_ids: tagIds })
}
