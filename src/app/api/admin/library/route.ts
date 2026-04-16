import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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

  const { id, title, category, level, difficulty, intro_text, content, allowed_roles, is_active, attachments } = body

  if (!title || !category || !level || !difficulty) {
    return NextResponse.json({ error: 'title, category, level, and difficulty are required' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    title,
    category,
    level,
    difficulty,
    intro_text: intro_text ?? null,
    content: content ?? { words: [], exercises: [] },
    allowed_roles: allowed_roles ?? ['teacher', 'teacher_exam'],
    is_active: is_active ?? true,
    attachments: Array.isArray(attachments) ? attachments : [],
  }

  // Allow the client to supply a pre-generated UUID (used when files were
  // uploaded before the sheet was created, so storage paths align)
  if (id && typeof id === 'string' && id.length > 0) {
    insert.id = id
  }

  const { data, error } = await supabase
    .from('study_sheets')
    .insert(insert)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data, { status: 201 })
}
