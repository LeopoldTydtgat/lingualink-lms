import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { JoinClickSchema } from '@/lib/validation/schemas'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/join-click
// Logs a "Join Class" click into lesson_join_clicks — for TEACHERS and STUDENTS.
//
// lesson_join_clicks has deny-all RLS (RLS enabled, zero policies) — only
// service_role can write. Every insert therefore goes through the service-role
// admin client here; client-side inserts are impossible by design.
//
// The authenticated caller must be a party to the lesson:
//   - Teacher: lessons.teacher_id references profiles.id, and profiles.id IS the
//     auth-user UUID, so it compares directly against user.id from getUser().
//   - Student: lessons.student_id references students.id (the table PK, NOT the
//     auth UUID). Students carry a students.auth_user_id column for the
//     indirection, so we resolve user.id -> students.id and match that against
//     lesson.student_id. Never compare the auth UUID to student_id directly.
//
// The user_id column in lesson_join_clicks holds profiles.id for teacher rows and
// students.id for student rows (mirrors each portal entity's PK); user_type
// ('teacher' | 'student') distinguishes them.
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
      .select('id, teacher_id, student_id')
      .eq('id', lessonId)
      .maybeSingle()

    if (lessonError) {
      console.error('[join-click] lesson lookup failed:', lessonError)
      return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }
    if (!lesson) return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })

    // Resolve the caller's relationship to this lesson and pick the click row.
    // teacher_id references profiles.id (the auth UUID) — direct comparison.
    // student_id references students.id (the portal PK) — resolved through the
    // students.auth_user_id indirection below.
    let clickUserType: 'teacher' | 'student'
    let clickUserId: string

    if (lesson.teacher_id === user.id) {
      // Unchanged teacher behaviour.
      clickUserType = 'teacher'
      clickUserId = user.id
    } else {
      // Not the teacher — check whether the caller is this lesson's student.
      const { data: student, error: studentError } = await adminClient
        .from('students')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle()

      if (studentError) {
        console.error('[join-click] student lookup failed:', studentError)
        return NextResponse.json({ error: 'Server error' }, { status: 500 })
      }

      if (student && student.id === lesson.student_id) {
        clickUserType = 'student'
        clickUserId = student.id
      } else {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const { error: insertError } = await adminClient
      .from('lesson_join_clicks')
      .insert({
        lesson_id: lessonId,
        user_type: clickUserType,
        user_id: clickUserId,
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
