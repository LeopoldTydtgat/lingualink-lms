import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

// DELETE /api/admin/tags/[id] — remove a tag from the vocabulary
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Tag not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  const { data: existing, error: existingError } = await adminClient
    .from('tags')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (existingError) {
    console.error('admin tag delete — read error:', id, existingError)
    return NextResponse.json({ error: 'Could not delete the tag.' }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Tag not found.' }, { status: 404 })
  }

  // sheet_tags.tag_id is ON DELETE CASCADE
  // (20260715120000_new345_library_owner_tags_activities.sql), so this also
  // unlabels every sheet carrying the tag. That is the intended meaning of
  // retiring a tag, and it destroys no authored content — only the association.
  const { error } = await adminClient
    .from('tags')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('admin tag delete error:', id, error)
    return NextResponse.json({ error: 'Could not delete the tag.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
