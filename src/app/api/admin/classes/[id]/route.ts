import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/admin/classes/[id]
// Returns full detail for a single lesson including teacher, student, training, and report link
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: lesson, error } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_at,
      cancellation_reason,
      teams_join_url,
      teams_meeting_id,
      training_id,
      teacher_id,
      student_id,
      created_at,
      updated_at,
      reminder_24_sent,
      reminder_1h_sent,
      profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url,
        timezone
      ),
      students!lessons_student_id_fkey (
        id,
        full_name,
        photo_url,
        timezone
      ),
      trainings!lessons_training_id_fkey (
        id,
        package_name,
        total_hours,
        hours_consumed
      )
    `)
    .eq('id', id)
    .single()

  if (error || !lesson) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  // Check if a report exists for this lesson
  const { data: report } = await supabase
    .from('reports')
    .select('id, status')
    .eq('lesson_id', id)
    .maybeSingle()

  // Flatten nested join arrays
  const result = {
    ...lesson,
    teacher: Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles,
    student: Array.isArray(lesson.students) ? lesson.students[0] : lesson.students,
    training: Array.isArray(lesson.trainings) ? lesson.trainings[0] : lesson.trainings,
    report: report ?? null,
    profiles: undefined,
    students: undefined,
    trainings: undefined,
  }

  return NextResponse.json({ lesson: result })
}

// PATCH /api/admin/classes/[id]
// Admin can edit any class field — no 24hr restriction applies
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const { action, ...fields } = body

  // Fetch the current lesson so we can handle hours adjustments correctly
  const { data: existing, error: fetchError } = await supabase
    .from('lessons')
    .select('id, teacher_id, student_id, training_id, scheduled_at, duration_minutes, status')
    .eq('id', id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  // --- CANCEL action ---
  if (action === 'cancel') {
    const { cancellation_reason } = fields

    const { error: cancelError } = await supabase
      .from('lessons')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: cancellation_reason ?? 'Cancelled by admin',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (cancelError) {
      return NextResponse.json({ error: cancelError.message }, { status: 500 })
    }

    // Refund hours to training — admin cancellations always refund
    const { data: training } = await supabase
      .from('trainings')
      .select('hours_consumed')
      .eq('id', existing.training_id)
      .single()

    if (training) {
      const hoursToRefund = existing.duration_minutes / 60
      await supabase
        .from('trainings')
        .update({ hours_consumed: Math.max(0, training.hours_consumed - hoursToRefund) })
        .eq('id', existing.training_id)
    }

    return NextResponse.json({ success: true })
  }

  // --- RESCHEDULE / EDIT action ---
  // Build update payload from whichever fields were sent
  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (fields.scheduled_at) updatePayload.scheduled_at = fields.scheduled_at
  if (fields.teacher_id) updatePayload.teacher_id = fields.teacher_id
  if (fields.cancellation_reason !== undefined) updatePayload.cancellation_reason = fields.cancellation_reason

  // If duration changed, adjust hours on the training
  if (fields.duration_minutes && fields.duration_minutes !== existing.duration_minutes) {
    updatePayload.duration_minutes = fields.duration_minutes

    const { data: training } = await supabase
      .from('trainings')
      .select('hours_consumed')
      .eq('id', existing.training_id)
      .single()

    if (training) {
      const oldHours = existing.duration_minutes / 60
      const newHours = fields.duration_minutes / 60
      const adjusted = training.hours_consumed - oldHours + newHours
      await supabase
        .from('trainings')
        .update({ hours_consumed: Math.max(0, adjusted) })
        .eq('id', existing.training_id)
    }
  }

  const { error: updateError } = await supabase
    .from('lessons')
    .update(updatePayload)
    .eq('id', id)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// DELETE /api/admin/classes/[id]
// Hard-deletes a lesson record. Only allowed when status is cancelled.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const adminClient = createAdminClient()

  const { data: lesson, error: fetchError } = await adminClient
    .from('lessons')
    .select('id, status')
    .eq('id', id)
    .single()

  if (fetchError || !lesson) {
    return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
  }

  const cancelledStatuses = ['cancelled', 'cancelled_by_student', 'cancelled_by_teacher']
  if (!cancelledStatuses.includes(lesson.status)) {
    return NextResponse.json({ error: 'Only cancelled classes can be deleted. Please cancel the class first.' }, { status: 422 })
  }

  const { error: deleteError } = await adminClient
    .from('lessons')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
