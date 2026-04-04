import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import StudentLeftNav from '@/components/student/layout/StudentLeftNav'
import StudentTopHeader from '@/components/student/layout/StudentTopHeader'
import StudentRightPanel from '@/components/student/layout/StudentRightPanel'

export default async function StudentDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/student/login')

  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, photo_url, is_active, timezone')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')
  if (!student.is_active) redirect('/student/login')

  // Next scheduled lesson — for countdown and join button in right panel
  const { data: nextLesson } = await supabase
    .from('lessons')
    .select('scheduled_at, teams_join_url, duration_minutes')
    .eq('student_id', student.id)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // Active training — for hours balance and end date
  const { data: training } = await supabase
    .from('trainings')
    .select('total_hours, hours_consumed, end_date')
    .eq('student_id', student.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Exercise counts — assigned vs completed
  const { count: assignedCount } = await supabase
    .from('assignments')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student.id)

  const { count: completedCount } = await supabase
    .from('exercise_completions')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student.id)

  const hoursRemaining = training
    ? Math.max(0, (training.total_hours ?? 0) - (training.hours_consumed ?? 0))
    : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <StudentTopHeader
        studentName={student.full_name}
        photoUrl={student.photo_url ?? null}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <StudentLeftNav />
        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            backgroundColor: '#f9fafb',
            padding: '32px',
          }}
        >
          {children}
        </main>
        <StudentRightPanel
          studentId={student.id}
          nextLesson={nextLesson ?? null}
          hoursRemaining={hoursRemaining}
          trainingEndDate={training?.end_date ?? null}
          assignedExercises={assignedCount ?? 0}
          completedExercises={completedCount ?? 0}
        />
      </div>
    </div>
  )
}