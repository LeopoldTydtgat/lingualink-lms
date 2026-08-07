import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ReportFormClient from './ReportFormClient'

type Props = {
  params: Promise<{ id: string }>
}

type MaterialSheet = {
  id: string
  title: string
  attachments: { name: string; type: string }[]
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'

  const { data: report, error } = await supabase
    .from('reports')
    .select(`
      id,
      status,
      did_class_happen,
      no_show_type,
      feedback_text,
      additional_details,
      level_data,
      student_confirmed,
      impersonation_note,
      deadline_at,
      completed_at,
      flagged_at,
      lesson:lessons (
        id,
        scheduled_at,
        duration_minutes,
        student:students (
          id,
          full_name,
          photo_url
        ),
        teacher:profiles (
          id,
          full_name
        )
      )
    `)
    .eq('id', id)
    .single()

  if (error || !report) notFound()

  // Supabase returns joined relations as arrays — flatten to single objects
  const lesson = (Array.isArray(report.lesson) ? report.lesson[0] : report.lesson) as any
  const teacher = (Array.isArray(lesson?.teacher) ? lesson.teacher[0] : lesson?.teacher) as { id: string; full_name: string } | null
  const student = (Array.isArray(lesson?.student) ? lesson.student[0] : lesson?.student) as { id: string; full_name: string; photo_url: string | null } | null

  // Teachers can only view their own reports
  if (!isAdmin && teacher?.id !== user.id) {
    redirect('/reports')
  }

  // Fetch study sheets already assigned for this lesson
  const { data: assignments } = await supabase
    .from('assignments')
    .select('study_sheet_id')
    .eq('lesson_id', lesson?.id ?? '')

  const assignedSheetIds = (assignments ?? []).map(a => a.study_sheet_id)

  let assignedSheets: { id: string; title: string }[] = []
  if (assignedSheetIds.length > 0) {
    const { data: sheets } = await supabase
      .from('study_sheets')
      .select('id, title')
      .in('id', assignedSheetIds)
    assignedSheets = sheets ?? []
  }

  // Teaching material the teacher can hand out from this report. Deliberately
  // the user-scoped client, never createAdminClient(): RLS is what decides
  // which staff sheets this caller may see at all. is_active + audience='staff'
  // mirror the checks POST /api/teacher/material-assignments re-applies before
  // it will issue a grant, so the picker cannot offer something the route
  // would refuse. PDF filtering is left to the client, which needs the
  // non-PDF rows in order to disable them with a reason.
  const { data: materialRows, error: materialError } = await supabase
    .from('study_sheets')
    .select('id, title, attachments')
    .eq('is_active', true)
    .eq('audience', 'staff')
    .order('title')

  if (materialError) {
    console.error('Report page: teaching material load failed:', materialError.message)
  }

  // On a failed query materialRows is null, so the prop is an empty array and
  // the picker shows its "No teaching materials available." state rather than
  // an empty select that looks like a working control.
  const materialSheets: MaterialSheet[] = (materialRows ?? []).map((row: any) => ({
    id: row.id,
    title: row.title,
    attachments: Array.isArray(row.attachments)
      ? (row.attachments as { name: string; type: string }[])
      : [],
  }))

  // Build a clean report object with correct types
  const cleanReport = {
    ...report,
    lesson: lesson ? { ...lesson, teacher, student } : null,
  }

  return (
    <ReportFormClient
      report={cleanReport as any}
      profile={profile ?? { id: '', full_name: '', role: '' }}
      isAdmin={isAdmin}
      assignedSheetIds={assignedSheetIds}
      assignedSheets={assignedSheets}
      materialSheets={materialSheets}
    />
  )
}
