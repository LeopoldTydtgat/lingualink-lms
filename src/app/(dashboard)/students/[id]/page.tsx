import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import StudentDetailClient from './StudentDetailClient'

type RawSheetJoin = { title: string; category: string; level: string } | null

type RawAssignmentRow = {
  id: string
  assigned_at: string
  study_sheets: RawSheetJoin | RawSheetJoin[]
}

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
  const adminClient = createAdminClient()
  const { data: training, error } = await adminClient
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
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !training) notFound()

  // Non-admin teachers can only view their own trainings
  if (!isAdmin && training.teacher_id !== user.id) notFound()

  // Fetch all lessons for this training
  const { data: lessons } = await adminClient
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
    ? await adminClient
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

  // Fetch assignments for this student
  const studentRecord = Array.isArray(training.students)
    ? training.students[0]
    : training.students
  const studentId = (studentRecord as { id: string } | null)?.id

  const { data: rawAssignments } = studentId
    ? await adminClient
        .from('assignments')
        .select('id, assigned_at, study_sheets(title, category, level)')
        .eq('student_id', studentId)
        .order('assigned_at', { ascending: false })
    : { data: [] }

  const assignments = ((rawAssignments ?? []) as RawAssignmentRow[]).map((a) => {
    const rawSheet: unknown = Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets
    const sheet = rawSheet as RawSheetJoin
    return {
      id: a.id,
      assigned_at: a.assigned_at,
      study_sheet: {
        title: sheet?.title ?? '—',
        category: sheet?.category ?? '—',
        level: sheet?.level ?? '—',
      },
    }
  })

  const now = new Date()
  const upcomingLessons = lessons?.filter(l => new Date(l.scheduled_at) >= now) ?? []
  const pastLessons = lessons?.filter(l => new Date(l.scheduled_at) < now) ?? []

  return (
    <StudentDetailClient
      training={training as unknown as Parameters<typeof StudentDetailClient>[0]['training']}
      upcomingLessons={upcomingLessons as unknown as Parameters<typeof StudentDetailClient>[0]['upcomingLessons']}
      pastLessons={pastLessons as unknown as Parameters<typeof StudentDetailClient>[0]['pastLessons']}
      reports={reports ?? []}
      isAdmin={isAdmin}
      currentUserId={user.id}
      assignments={assignments}
    />
  )
}
