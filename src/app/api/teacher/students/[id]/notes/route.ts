import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TeacherNotesSchema } from '@/lib/validation/schemas'

// PATCH /api/teacher/students/[id]/notes
// Body: { notes: string }
// Writes ONLY students.teacher_notes for the student at [id]. Never touches
// students.admin_notes or trainings.notes.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (profile.role !== 'teacher' && profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const parsed = TeacherNotesSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid notes value.' }, { status: 400 })
  }

  // Mirrors the view gate in students/[id]/page.tsx - keep in sync. That gate is
  // keyed on training_id (its [id] param is a training id); this route's [id] is
  // a student id, and lessons carries student_id directly, so the same B1/B2
  // condition is expressed via lessons.student_id instead of lessons.training_id.
  // Formal training_teachers assignment alone does not grant access - falls closed.
  if (profile.role !== 'admin') {
    const gateNow = new Date()
    const { data: gateLessonsRaw } = await admin
      .from('lessons')
      .select('id, scheduled_at, status')
      .eq('student_id', id)
      .eq('teacher_id', profile.id)

    type GateLessonRow = { id: string; scheduled_at: string | null; status: string }
    const gateLessons = (gateLessonsRaw ?? []) as GateLessonRow[]

    // B1: an upcoming scheduled lesson with this student held by this teacher.
    let hasActiveClaim = gateLessons.some(
      l => l.status === 'scheduled' && l.scheduled_at && new Date(l.scheduled_at) > gateNow
    )

    // B2: an open (pending/reopened) report on one of this teacher's lessons with this student.
    if (!hasActiveClaim && gateLessons.length > 0) {
      const gateLessonIds = gateLessons.map(l => l.id)
      const { data: gateReportsRaw } = await admin
        .from('reports')
        .select('status, deadline_at')
        .in('lesson_id', gateLessonIds)
        .in('status', ['pending', 'reopened'])

      // 'pending' counts only inside its window; 'reopened' counts until completed (stale deadline).
      type GateReportRow = { status: string; deadline_at: string | null }
      hasActiveClaim = ((gateReportsRaw ?? []) as GateReportRow[]).some(
        r => r.status === 'reopened' || (r.deadline_at && new Date(r.deadline_at) > gateNow)
      )
    }

    if (!hasActiveClaim) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await admin
    .from('students')
    .update({ teacher_notes: parsed.data.notes })
    .eq('id', id)
    .select('teacher_notes')
    .maybeSingle()

  if (error) {
    console.error('[PATCH /api/teacher/students/[id]/notes]', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  if (!data) {
    return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
  }

  return NextResponse.json({ teacher_notes: data.teacher_notes })
}
