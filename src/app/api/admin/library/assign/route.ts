import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentHomeworkAssignedEmailContent } from '@/lib/email/templates'

// POST /api/admin/library/assign
// Assigns a study sheet directly to a student (not linked to a lesson).
// lesson_id is left null — direct admin assignment.
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
  const { study_sheet_id, student_id, assigned_by } = body

  if (!study_sheet_id || !student_id || !assigned_by) {
    return NextResponse.json(
      { error: 'study_sheet_id, student_id, and assigned_by are required' },
      { status: 400 }
    )
  }

  // Check if already assigned (avoid duplicates for direct admin assignments)
  const { data: existing } = await supabase
    .from('assignments')
    .select('id')
    .eq('study_sheet_id', study_sheet_id)
    .eq('student_id', student_id)
    .is('lesson_id', null)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: 'This sheet has already been assigned to this student.' },
      { status: 409 }
    )
  }

  const { data, error } = await supabase
    .from('assignments')
    .insert({
      study_sheet_id,
      student_id,
      assigned_by,
      lesson_id: null,   // direct admin assignment — not tied to a lesson
      assigned_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    // lesson_id may be NOT NULL on the table — surface a clear message
    if (error.message.includes('null value') || error.message.includes('not-null')) {
      return NextResponse.json(
        { error: 'The assignments table requires lesson_id to be non-null. Please run: ALTER TABLE assignments ALTER COLUMN lesson_id DROP NOT NULL; in Supabase SQL editor first.' },
        { status: 500 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  try {
    const adminClient = createAdminClient()
    const [{ data: student }, { data: sheet }, { data: assignerProfile }] = await Promise.all([
      adminClient.from('students').select('email, full_name').eq('id', student_id).single(),
      adminClient.from('study_sheets').select('title').eq('id', study_sheet_id).single(),
      adminClient.from('profiles').select('full_name').eq('id', user.id).single(),
    ])
    const assignerName = assignerProfile?.full_name ?? 'Your teacher'
    if (student?.email && sheet?.title) {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online — New study sheet assigned',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          subject: 'New study sheet assigned',
          bodyHtml: studentHomeworkAssignedEmailContent(assignerName, [sheet.title]),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    }
  } catch {
    // email failure is non-blocking
  }

  return NextResponse.json(data, { status: 201 })
}
