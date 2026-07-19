import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// GET /api/admin/library — returns all study sheets
export async function GET() {
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

  const { data, error } = await supabase
    .from('study_sheets')
    .select('*')
    .order('title', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

// POST /api/admin/library — create a new study sheet
export async function POST(request: Request) {
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

  const { id, title, category, level, difficulty, intro_text, content, allowed_roles, is_active, attachments, audience } = body

  if (!title || !category) {
    return NextResponse.json({ error: 'title and category are required' }, { status: 400 })
  }

  // Exercises/MCQs now live in the activities table, never in study_sheets.content.
  // Content stores words only (vocabulary sheets); exercises is kept as an empty
  // array purely for the backward-compatible content shape the readers expect.
  const contentObj: Record<string, unknown> =
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {}
  const storedContent = {
    words: Array.isArray(contentObj.words) ? contentObj.words : [],
    exercises: [],
  }

  const insert: Record<string, unknown> = {
    title,
    category,
    level: level || '',
    difficulty: difficulty ?? null,
    intro_text: intro_text ?? null,
    content: storedContent,
    allowed_roles: allowed_roles ?? ['teacher', 'teacher_exam'],
    // Audience is an access boundary: only 'student' or 'staff'. Absent/invalid
    // coerces to the fail-safe 'staff' so an unlabelled sheet never reaches students.
    audience: audience === 'student' ? 'student' : 'staff',
    is_active: is_active ?? true,
    attachments: Array.isArray(attachments) ? attachments : [],
  }

  // Allow the client to supply a pre-generated UUID (used when files were
  // uploaded before the sheet was created, so storage paths align)
  if (id && typeof id === 'string' && id.length > 0) {
    insert.id = id
  }

  // Insert via admin client. RLS on study_sheets blocks direct writes from
  // session clients; the role check above already gates this branch to admins.
  const adminClient = createAdminClient()
  const { data, error } = await adminClient
    .from('study_sheets')
    .insert(insert)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // data is the freshly inserted row; guard the no-row case.
  if (!data) return NextResponse.json({ error: 'Sheet was not created.' }, { status: 500 })

  return NextResponse.json(data, { status: 201 })
}
