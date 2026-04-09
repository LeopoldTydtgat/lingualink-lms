import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ReportFormClient from './ReportFormClient'

type Props = {
  params: Promise<{ id: string }>
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

  if (!profile) redirect('/login')

  const isAdmin = profile.role === 'admin'

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

  // Build a clean report object with correct types
  const cleanReport = {
    ...report,
    lesson: lesson ? { ...lesson, teacher, student } : null,
  }

  return (
    <ReportFormClient
      report={cleanReport as any}
      profile={profile}
      isAdmin={isAdmin}
      assignedSheetIds={assignedSheetIds}
    />
  )
}