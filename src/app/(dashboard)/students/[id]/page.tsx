import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import StudentDetailClient from './StudentDetailClient'

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'

  // Fetch the training with student info
  const { data: training, error } = await supabase
    .from('trainings')
    .select(`
      id,
      status,
      total_hours,
      hours_consumed,
      start_date,
      end_date,
      package_type,
      notes,
      teacher_id,
      students (
        id,
        full_name,
        email,
        photo_url,
        self_reported_level,
        timezone
      ),
      profiles!trainings_teacher_id_fkey (
        id,
        full_name
      )
    `)
    .eq('id', id)
    .single()

  if (error || !training) notFound()

  // Non-admin teachers can only view their own trainings
  if (!isAdmin && training.teacher_id !== user.id) notFound()

  // Fetch all lessons for this training
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teams_join_url,
      teacher_id,
      profiles!lessons_teacher_id_fkey (
        full_name
      )
    `)
    .eq('training_id', id)
    .order('scheduled_at', { ascending: true })

  // Fetch completed reports for this training's lessons
  const lessonIds = lessons?.map(l => l.id) ?? []

  const { data: reports } = lessonIds.length > 0
    ? await supabase
        .from('reports')
        .select(`
          id,
          lesson_id,
          did_class_happen,
          no_show_type,
          feedback_text,
          level_data,
          status,
          completed_at
        `)
        .in('lesson_id', lessonIds)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
    : { data: [] }

  const now = new Date()
  const upcomingLessons = lessons?.filter(l => new Date(l.scheduled_at) >= now) ?? []
  const pastLessons = lessons?.filter(l => new Date(l.scheduled_at) < now) ?? []

  return (
    <StudentDetailClient
      training={training as any}
      upcomingLessons={upcomingLessons as any}
      pastLessons={pastLessons as any}
      reports={reports ?? []}
      isAdmin={isAdmin}
      currentUserId={user.id}
    />
  )
}