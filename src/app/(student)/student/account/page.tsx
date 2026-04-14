import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AccountClient from './AccountClient'

export default async function StudentAccountPage() {
  const supabase = await createClient()

  // Get authenticated user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Use the admin client to bypass RLS — the user's identity has already been
  // verified above. The regular server client cannot reliably read the students
  // row (column-level REVOKEs on admin-only fields cause PostgREST to deny the
  // wildcard, returning null data).
  const admin = createAdminClient()

  console.log('[DEBUG] Auth user id:', user.id)

  // Get student record — exclude admin-only columns to avoid leaking sensitive data
  const { data: student, error: studentError } = await admin
    .from('students')
    .select('id, auth_user_id, full_name, email, photo_url, phone, timezone, language_preference, learning_goals, interests, self_assessed_level, placement_test_result, placement_test_taken_at, company_id, customer_number, is_private, academic_advisor_id, status, teacher_notes, native_language, learning_language, current_fluency_level, is_active, created_at, updated_at')
    .eq('auth_user_id', user.id)
    .single()

  if (studentError) {
    console.error('[StudentAccountPage] Failed to load student record:', studentError)
  }

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
