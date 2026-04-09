import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StudyClient from './StudyClient'

export default async function StudyPage() {
  const supabase = await createClient()

  // Get the logged-in user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

  // Fetch all assignments for this student, joined with study sheet details
  const { data: assignmentsRaw } = await supabase
    .from('assignments')
    .select(`
      id,
      lesson_id,
      assigned_at,
      study_sheets (
        id,
        title,
        category,
        level,
        difficulty,
        is_active
      )
    `)
    .eq('student_id', student.id)
    .order('assigned_at', { ascending: false })

  // Fetch all exercise completions for this student (to mark assigned work as done)
  const { data: completionsRaw } = await supabase
    .from('exercise_completions')
    .select('id, sheet_id, assignment_id, completed_at, score')
    .eq('student_id', student.id)

  // Fetch all active study sheets for the "Practice on Your Own" library
  const { data: libraryRaw } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty')
    .eq('is_active', true)
    .order('title', { ascending: true })

  // Flatten Supabase nested joins (they return arrays, not single objects)
  const assignments = (assignmentsRaw ?? []).map((a) => ({
    id: a.id as string,
    lesson_id: a.lesson_id as string,
    assigned_at: a.assigned_at as string,
    study_sheet: Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets,
  }))

  const completions = completionsRaw ?? []
  const library = libraryRaw ?? []

  return (
    <StudyClient
      studentId={student.id}
      assignments={assignments}
      completions={completions}
      library={library}
    />
  )
}
