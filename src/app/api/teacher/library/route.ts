import { NextResponse } from 'next/server'
import { requireTeacher } from '@/lib/auth/requireTeacher'

// POST /api/teacher/library - a teacher creates a study sheet in their OWN
// private library. Teacher-owned sheets are ALWAYS audience='staff' (private
// prep material). Student worksheets stay admin-published only.
//
// Enforcement is RLS, not this code: the insert runs through the user-scoped
// session client, and the "Teachers insert own sheets" WITH CHECK policy pins
// owner_id = auth.uid() AND audience = 'staff' AND a current teacher. That is
// why nothing here uses createAdminClient - the service-role client would
// bypass the very policy that makes this route safe.
export async function POST(request: Request) {
  const auth = await requireTeacher()
  if (!auth) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { user, supabase } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Accept ONLY these fields from the client. id, audience, owner_id,
  // allowed_roles, is_active, and content are deliberately NOT read from the
  // body - they are fixed server-side below (NEW370: the teacher flow starts
  // clean and can never be coerced into a student-audience or foreign-owner sheet).
  const { title, category, level, difficulty, intro_text } = body as {
    title?: unknown
    category?: unknown
    level?: unknown
    difficulty?: unknown
    intro_text?: unknown
  }

  // Same validation strictness as the admin create route: title and category
  // are required. category must pass the study_sheets_category_check constraint.
  if (!title || typeof title !== 'string' || !category || typeof category !== 'string') {
    return NextResponse.json({ error: 'title and category are required' }, { status: 400 })
  }
  if (category !== 'vocabulary' && category !== 'grammar') {
    return NextResponse.json({ error: 'category must be vocabulary or grammar' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    title,
    category,
    level: typeof level === 'string' ? level : '',
    difficulty: typeof difficulty === 'number' ? difficulty : null,
    intro_text: typeof intro_text === 'string' ? intro_text : null,
    // Server-fixed, never client-supplied:
    owner_id: user.id,
    // Teacher-owned material is ALWAYS private staff-audience.
    audience: 'staff',
    is_active: true,
    // Fixed empty body: teacher create is metadata-only; there is no authoring
    // surface for exercises/activities on this route. Matches the admin route's
    // stored shape so downstream readers never see a null content.
    content: { words: [], exercises: [] },
    // Required, not merely cosmetic: the owner's own SELECT tier for a
    // staff-audience sheet is (allowed_roles @> ['teacher']). Without 'teacher'
    // here the INSERT ... RETURNING below would come back empty (RLS filters the
    // returned row) and the owner could not read their own sheet - or its files
    // through the library-file proxy - afterwards. This is the column default,
    // set explicitly so correctness never depends on the live default drifting.
    allowed_roles: ['teacher', 'teacher_exam'],
  }

  // User-scoped insert: RLS is the gate. The DB mints the id.
  const { data, error } = await supabase
    .from('study_sheets')
    .insert(insert)
    .select('id, title, category, level, difficulty')
    .single()

  if (error) {
    // An RLS WITH CHECK violation (or a filtered-empty RETURNING) is an
    // authorisation failure, not a server fault - surface it as 403, not 500,
    // and never as success.
    const denied = error.code === '42501' || /row-level security/i.test(error.message)
    return NextResponse.json(
      { error: denied ? 'Forbidden' : error.message },
      { status: denied ? 403 : 500 }
    )
  }
  if (!data) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json(data, { status: 201 })
}
