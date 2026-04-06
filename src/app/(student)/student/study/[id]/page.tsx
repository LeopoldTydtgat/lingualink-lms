import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import StudySheetClient from './StudySheetClient'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ assignment?: string }>
}

export default async function StudySheetPage({ params, searchParams }: Props) {
  const { id } = await params
  const { assignment: assignmentId } = await searchParams

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

  // Fetch the study sheet
  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, content')
    .eq('id', id)
    .eq('is_active', true)
    .single()

  if (!sheet) notFound()

  // Fetch exercises for this sheet
  const { data: exercisesRaw } = await supabase
    .from('exercises')
    .select('id, question_text, options, correct_answer, explanation, duration_minutes')
    .eq('study_sheet_id', id)
    .order('id', { ascending: true })

  const exercises = exercisesRaw ?? []

  // Fetch any completions this student already has for this sheet under this assignment
  // (so we know if they've already done it and can show results)
  const { data: existingCompletions } = await supabase
    .from('exercise_completions')
    .select('id, assignment_id, completed_at, score')
    .eq('student_id', student.id)
    .eq('sheet_id', id)

  const alreadyCompleted = (existingCompletions ?? []).some(
    (c) => (assignmentId ? c.assignment_id === assignmentId : c.assignment_id === null)
  )

  return (
    <StudySheetClient
      studentId={student.id}
      sheet={sheet}
      exercises={exercises}
      assignmentId={assignmentId ?? null}
      alreadyCompleted={alreadyCompleted}
    />
  )
}
