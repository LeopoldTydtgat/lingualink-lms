import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getTeacherScopedStudentIds } from '@/lib/access/bookedClass'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentHomeworkAssignedEmailContent } from '@/lib/email/templates'

// POST /api/teacher/library/assign
// Teacher (or admin) assigns an admin-published student worksheet directly to
// one or more of their students. lesson_id is null - a direct, lesson-less
// assignment. Scoping to the teacher's own students is enforced here in JS
// (the assignments teacher INSERT RLS policy only guards assigned_by), so the
// insert uses the service-role client after the scope check passes.
export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Gate pattern mirrors /api/teacher/notify-homework-assigned: session profile,
  // role teacher/admin OR account_types includes school_admin. full_name comes
  // from the session profile, never the request body.
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))
  const isAuthorized = profile?.role === 'teacher' || isAdmin

  if (!profile || !isAuthorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { study_sheet_id, student_ids } = body

  if (!study_sheet_id || !Array.isArray(student_ids) || student_ids.length === 0) {
    return NextResponse.json(
      { error: 'study_sheet_id and a non-empty student_ids array are required' },
      { status: 400 }
    )
  }

  const adminClient = createAdminClient()

  // Validate the sheet: only active, admin-published student worksheets are
  // assignable (audience='student', owner_id IS NULL). Teacher-owned prep is
  // always audience='staff' and must never reach a student.
  const { data: sheet, error: sheetError } = await adminClient
    .from('study_sheets')
    .select('id, title, is_active, audience, owner_id')
    .eq('id', study_sheet_id)
    .maybeSingle()

  if (sheetError || !sheet) {
    return NextResponse.json({ error: 'Study sheet not found' }, { status: 404 })
  }
  if (sheet.is_active !== true || sheet.audience !== 'student' || sheet.owner_id !== null) {
    return NextResponse.json(
      { error: 'This sheet cannot be assigned to students' },
      { status: 400 }
    )
  }

  // Scope check: a non-admin may only assign to their own Condition-B booked-class
  // students. Admin (null) skips the filter. Reject with the offending ids listed.
  const scoped = await getTeacherScopedStudentIds(adminClient, user.id, isAdmin)
  if (scoped !== null) {
    const allowed = new Set(scoped)
    const rejected = student_ids.filter((id: string) => !allowed.has(id))
    if (rejected.length > 0) {
      return NextResponse.json(
        { error: 'Some students are not assignable by you.', rejected },
        { status: 403 }
      )
    }
  }

  // Dedupe against existing lesson-less assignments for this sheet. Use .is(null)
  // for lesson_id - .eq(null) matches no rows in Postgres.
  const { data: existingRows } = await adminClient
    .from('assignments')
    .select('student_id')
    .eq('study_sheet_id', study_sheet_id)
    .is('lesson_id', null)
    .in('student_id', student_ids)

  const alreadyAssigned = new Set(
    (existingRows ?? []).map((r: { student_id: string }) => r.student_id)
  )
  const toAssign = student_ids.filter((id: string) => !alreadyAssigned.has(id))
  const skipped = student_ids.filter((id: string) => alreadyAssigned.has(id))

  let assigned: string[] = []
  if (toAssign.length > 0) {
    const nowIso = new Date().toISOString()
    const { data: inserted, error } = await adminClient
      .from('assignments')
      .insert(
        toAssign.map((student_id: string) => ({
          study_sheet_id,
          student_id,
          assigned_by: user.id,
          lesson_id: null,
          assigned_at: nowIso,
        }))
      )
      .select('student_id')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    assigned = (inserted ?? []).map((r: { student_id: string }) => r.student_id)

    // Homework-assigned email per newly assigned student (non-blocking). Mirrors
    // the admin assign route: teacherName from the session profile, student email
    // resolved via the admin client.
    try {
      const assignerName = profile.full_name ?? 'Your teacher'
      const { data: students } = await adminClient
        .from('students')
        .select('id, email, full_name')
        .in('id', assigned)

      await Promise.all(
        (students ?? []).map((s: { id: string; email: string | null; full_name: string }) => {
          if (!s.email) return null
          return resend.emails.send({
            from: 'Lingualink Online <no-reply@lingualinkonline.com>',
            to: s.email,
            subject: 'Lingualink Online - Your teacher has assigned new exercises',
            html: buildEmailTemplate({
              recipientName: s.full_name,
              recipientFallback: 'Student',
              subject: 'Lingualink Online - Your teacher has assigned new exercises',
              bodyHtml: studentHomeworkAssignedEmailContent(assignerName, [sheet.title]),
              contactEmail: 'support@lingualinkonline.com',
            }),
          })
        })
      )
    } catch {
      // email failure is non-blocking
    }
  }

  return NextResponse.json({ assigned, skipped }, { status: 200 })
}
