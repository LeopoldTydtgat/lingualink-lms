import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ReportFormClient from './ReportFormClient'

type Props = {
  params: Promise<{ id: string }>
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  // Check the user is logged in
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get the teacher's profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  const isAdmin = profile.role === 'admin'

  // Fetch the report with lesson and student details
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

  // Teachers can only view their own reports
  if (!isAdmin && report.lesson?.teacher?.id !== user.id) {
    redirect('/reports')
  }

  return (
    <ReportFormClient
      report={report}
      profile={profile}
      isAdmin={isAdmin}
    />
  )
}