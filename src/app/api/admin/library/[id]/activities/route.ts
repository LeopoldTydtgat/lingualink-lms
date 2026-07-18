import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { McqActivityAuthorSchema, WritingTaskActivityAuthorSchema } from '@/lib/validation/activities'

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

// POST /api/admin/library/[id]/activities — create an activity for a sheet
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

  // Discriminate on the body's declared `type`. MCQ carries no `type` field and
  // is the default; a writing task declares itself. Each type is validated by
  // its own author schema, so a body shaped for one type can never satisfy the
  // other's schema — an MCQ body has no `content.prompt`, and a writing-task
  // body has neither `content.questions` nor `answer_key`.
  const declaredType =
    body != null && typeof body === 'object'
      ? (body as { type?: unknown }).type
      : undefined

  let activityType: 'mcq' | 'writing_task'
  let title: string
  let content: unknown
  // MCQ carries an answer key; a writing task never does — the column stays null.
  let answerKey: unknown

  if (declaredType === 'writing_task') {
    const parsed = WritingTaskActivityAuthorSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid activity data.', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    activityType = 'writing_task'
    title = parsed.data.title
    content = parsed.data.content
    answerKey = null
  } else {
    const parsed = McqActivityAuthorSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid activity data.', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    activityType = 'mcq'
    title = parsed.data.title
    content = parsed.data.content
    answerKey = parsed.data.answer_key
  }

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
      type: activityType,
      title: title.trim(),
      content,
      answer_key: answerKey,
    })
    .select(ACTIVITY_LIST_COLUMNS)
    .single()

  if (error) {
    console.error('admin activity create — insert error:', id, error)
    return NextResponse.json({ error: 'Could not create the activity.' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
