import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AccountClient from './AccountClient'

export default async function StudentAccountPage() {
  const supabase = await createClient()

  // Get authenticated user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('*')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

  // Get all trainings for this student, newest first
  const { data: trainings } = await supabase
    .from('trainings')
    .select('*')
    .eq('student_id', student.id)
    .order('start_date', { ascending: false })

  const allTrainings = trainings ?? []

  // Active training is the first active one, or the most recent if none active
  const activeTraining = allTrainings.find(t => t.status === 'active') ?? allTrainings[0] ?? null

  return (
    <AccountClient
      student={student}
      activeTraining={activeTraining}
      allTrainings={allTrainings}
    />
  )
}