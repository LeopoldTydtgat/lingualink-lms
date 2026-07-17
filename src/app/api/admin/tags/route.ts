import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { TagCreateSchema } from '@/lib/validation/tags'

// Postgres unique_violation — here, the unique (name, kind) constraint on tags.
const UNIQUE_VIOLATION = '23505'

// GET /api/admin/tags — the full tag vocabulary
export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const adminClient = createAdminClient()

  const { data, error } = await adminClient
    .from('tags')
    .select('id, name, kind, created_at')
    .order('kind', { ascending: true })
    .order('name', { ascending: true })

  if (error) {
    console.error('admin tags list error:', error)
    return NextResponse.json({ error: 'Could not load tags.' }, { status: 500 })
  }

  return NextResponse.json(data ?? [])
}

// POST /api/admin/tags — create a tag
export async function POST(request: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const parsed = TagCreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid tag data.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const { name, kind } = parsed.data

  const adminClient = createAdminClient()

  const { data, error } = await adminClient
    .from('tags')
    .insert({ name, kind })
    .select('id, name, kind, created_at')
    .single()

  if (error) {
    // The DB's unique (name, kind) is the authority on duplicates — a read-then-
    // insert check would still race. The constraint decides; this maps it to 409.
    if (error.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        { error: `A ${kind} tag named '${name}' already exists.` },
        { status: 409 }
      )
    }
    console.error('admin tag create error:', error)
    return NextResponse.json({ error: 'Could not create the tag.' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
