import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { JoinClickSchema } from '@/lib/validation/schemas'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/join-click
// Logs a TEACHER "Join Class" click into lesson_join_clicks.
//
// lesson_join_clicks has deny-all RLS (RLS enabled, zero policies) — only
// service_role can write. Every insert therefore goes through the service-role
// admin client here; client-side inserts are impossible by design.
//
// This route logs TEACHER clicks only: the authenticated caller must own the
// lesson (lesson.teacher_id === user.id). lessons.teacher_id references
// profiles.id, and profiles.id is the auth-user UUID, so the comparison against
// user.id from getUser() is the correct ownership check.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Authenticate server-side against the session cookie (anon key + RLS).
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

    // Parse and validate body via the shared Zod schema. A malformed/absent JSON
    // body → safeParse fails → 400 (never a 500).
    const body = await request.json().catch(() => null)
    const parsed = JoinClickSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const lessonId = parsed.data.lesson_id

    const adminClient = createAdminClient()

    // Look up the lesson owner. Explicit column list — never select('*').
    // maybeSingle(): zero rows is an expected outcome (bad/stale id), not an error.
    const { data: lesson, error: lessonError } = await adminClient
      .from('lessons')
      .select('id, teacher_id')
      .eq('id', lessonId)
      .maybeSingle()

    if (lessonError) {
      console.error('[join-click] lesson lookup failed:', lessonError)
      return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }
    if (!lesson) return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })

    // Teacher-only route: the caller must be the lesson's teacher.
    if (lesson.teacher_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { error: insertError } = await adminClient
      .from('lesson_join_clicks')
      .insert({
        lesson_id: lessonId,
        user_type: 'teacher',
        user_id: user.id,
      })

    if (insertError) {
      console.error('[join-click] insert failed:', insertError)
      return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error('[join-click] unexpected error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
