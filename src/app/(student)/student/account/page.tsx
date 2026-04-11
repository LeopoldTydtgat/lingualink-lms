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

  // Do NOT redirect to /student/login if student is null — the layout already
  // verified authentication. A missing student record is a data issue, not auth.
  if (!student) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#111827', marginBottom: '8px' }}>
          Account not found
        </h2>
        <p>Your student profile could not be loaded. Please contact admin.</p>
      </div>
    )
  }

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
