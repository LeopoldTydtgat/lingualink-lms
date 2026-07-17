import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { McqActivityAuthorSchema } from '@/lib/validation/activities'

// answer_key is deliberately absent. This is the list surface: it feeds the
// activities panel, which never needs answers. Only the single-activity GET
// (./[activityId]) returns the key, and only to populate the builder form.
const ACTIVITY_LIST_COLUMNS = 'id, sheet_id, position, type, title, content, created_at, updated_at'

// GET /api/admin/library/[id]/activities — list a sheet's activities
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // A non-uuid path segment can never name a row and would reach Postgres as a
  // 22P02 cast error, surfacing as a 500.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  const { data, error } = await adminClient
    .from('activities')
    .select(ACTIVITY_LIST_COLUMNS)
    .eq('sheet_id', id)
    .order('position', { ascending: true })

  if (error) {
    console.error('admin activities list error:', id, error)
    return NextResponse.json({ error: 'Could not load activities.' }, { status: 500 })
  }

  return NextResponse.json(data ?? [])
}

// POST /api/admin/library/[id]/activities — create an MCQ activity for a sheet
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  // A malformed or absent JSON body is a 400, never a 500.
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

  // The sheet must exist. activities.sheet_id is NOT NULL with an FK, so the
  // insert would fail anyway — this turns a 500 into an honest 404.
  const { data: sheet, error: sheetError } = await adminClient
    .from('study_sheets')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (sheetError) {
    console.error('admin activity create — sheet read error:', id, sheetError)
    return NextResponse.json({ error: 'Could not create the activity.' }, { status: 500 })
  }
  if (!sheet) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  // Append to the end: position = max(position) + 1 for this sheet. maybeSingle()
  // over a 1-row descending read reports "no activities yet" as data: null.
  const { data: last, error: positionError } = await adminClient
    .from('activities')
    .select('position')
    .eq('sheet_id', id)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Fail closed: guessing 0 here would stack a new activity on top of an
  // existing one's position.
  if (positionError) {
    console.error('admin activity create — position read error:', id, positionError)
    return NextResponse.json({ error: 'Could not create the activity.' }, { status: 500 })
  }

  const position = (last?.position ?? -1) + 1

  const { data, error } = await adminClient
    .from('activities')
    .insert({
      sheet_id: id,
      position,
      type: 'mcq',
      title: title.trim(),
      content,
      answer_key,
    })
    .select(ACTIVITY_LIST_COLUMNS)
    .single()

  if (error) {
    console.error('admin activity create — insert error:', id, error)
    return NextResponse.json({ error: 'Could not create the activity.' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
