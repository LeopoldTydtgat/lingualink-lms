import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

// Study-sheet categories the DB CHECK accepts. Validated in this route so a bad
// value returns a readable 400 instead of reaching Postgres and coming back as a
// raw study_sheets_category_check violation inside the 500 below — which the
// admin modal prints verbatim in its footer.
const CATEGORIES = ['vocabulary', 'grammar', 'listening', 'reading']

// Listening sheets carry study_sheets.links (jsonb, shape [{ title, url }]);
// reading sheets carry study_sheets.reading_text. Both arrive from the browser,
// so both are bounded and re-validated here — the modal's own filtering is
// convenience, never the gate.
const MAX_LINKS = 50
const MAX_READING_TEXT = 20000

type SheetLink = { title: string; url: string }

// Keeps only entries carrying a non-empty title AND a non-empty http(s) URL,
// capped at MAX_LINKS. Anything else is DROPPED rather than stored: a
// half-filled row renders as a broken link, and a javascript:/data: URL would be
// handed to a student as a clickable resource.
function normaliseLinks(value: unknown[]): SheetLink[] {
  const out: SheetLink[] = []
  for (const entry of value) {
    if (out.length >= MAX_LINKS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    if (title.length === 0 || url.length === 0) continue
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue
    out.push({ title, url })
  }
  return out
}

// '' (or whitespace only) is a legitimate "clear it" instruction and is stored
// as NULL, matching the nullable column.
function normaliseReadingText(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, MAX_READING_TEXT)
}

// GET /api/admin/library — returns all study sheets
export async function GET() {
  const supabase = await createClient()

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('study_sheets')
    .select('*')
    .order('title', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

// POST /api/admin/library — create a new study sheet
export async function POST(request: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  const { id, title, category, level, difficulty, intro_text, content, allowed_roles, is_active, attachments, audience, links, reading_text } = body

  if (!title || !category) {
    return NextResponse.json({ error: 'title and category are required' }, { status: 400 })
  }

  // Category is required above, so there is no "absent" case to allow through
  // here — only a value that is not one of the four the column accepts.
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${CATEGORIES.join(', ')}` },
      { status: 400 }
    )
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

  // links / reading_text are written ONLY when the client actually sent them.
  // Both columns carry their own defaults ('[]' and NULL), so an absent key must
  // stay absent rather than be written from a guess — and a value of the wrong
  // type is ignored entirely rather than stored.
  if (Array.isArray(links)) insert.links = normaliseLinks(links)
  if (typeof reading_text === 'string') insert.reading_text = normaliseReadingText(reading_text)

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
