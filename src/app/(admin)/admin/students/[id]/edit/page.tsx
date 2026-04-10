import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import EditStudentClient from './EditStudentClient'

export default async function EditStudentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createAdminClient()

  // Fetch the student row — includes sensitive admin-only fields
  const { data: student, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !student) notFound()

  // Fetch active training + assigned teachers for this student
  const { data: trainings } = await supabase
    .from('trainings')
    .select(`
      id,
      package_name,
      package_type,
      total_hours,
      hours_consumed,
      end_date,
      status,
      training_teachers (
        teacher_id
      )
    `)
    .eq('student_id', id)
    .order('created_at', { ascending: false })

  const trainingsArr = Array.isArray(trainings) ? trainings : []
  const activeTrain = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null

  // Extract assigned teacher IDs from the active training
  const assignedTeacherIds: string[] = []
  if (activeTrain) {
    const ttArr = Array.isArray(activeTrain.training_teachers)
      ? activeTrain.training_teachers
      : []
    for (const tt of ttArr) {
      if (tt.teacher_id && !assignedTeacherIds.includes(tt.teacher_id)) {
        assignedTeacherIds.push(tt.teacher_id)
      }
    }
  }

  // Fetch all active companies for the dropdown
  const { data: companies } = await supabase
    .from('companies')
    .select('id, name')
    .eq('status', 'active')
    .order('name')

  // Fetch all current teachers for the assigned-teachers toggle
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'teacher')
    .order('full_name')

  return (
    <EditStudentClient
      student={student}
      activeTrain={activeTrain}
      assignedTeacherIds={assignedTeacherIds}
      companies={companies ?? []}
      teachers={teachers ?? []}
    />
  )
}
