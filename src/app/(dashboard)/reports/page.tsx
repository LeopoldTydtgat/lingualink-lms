import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReportsClient from './ReportsClient'

export default async function ReportsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'

  const query = supabase
    .from('reports')
    .select(`
      id,
      status,
      did_class_happen,
      no_show_type,
      feedback_text,
      deadline_at,
      completed_at,
      flagged_at,
      created_at,
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
    .order('created_at', { ascending: false })

  if (!isAdmin) {
    query.eq('teacher_id', user.id)
  }

  const { data: rawReports, error } = await query

  if (error) {
    console.error('Error fetching reports:', error)
  }

  // Supabase returns nested joins as arrays — flatten them into single objects
  const reports = (rawReports ?? []).map((r: any) => {
    const lesson = Array.isArray(r.lesson) ? r.lesson[0] : r.lesson
    const teacher = lesson && Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson?.teacher
    const student = lesson && Array.isArray(lesson.student) ? lesson.student[0] : lesson?.student
    return {
      ...r,
      lesson: lesson ? { ...lesson, teacher, student } : null,
    }
  })

  return (
    <ReportsClient
      reports={reports}
      profile={profile ?? { id: '', full_name: '', role: '' }}
      isAdmin={isAdmin}
    />
  )
}
