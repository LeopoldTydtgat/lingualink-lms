import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import BookingClient from './BookingClient'
import { requireTz } from '@/lib/time/requireTz'

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ reschedule?: string }>
}) {
  const supabase = await createClient()
  const params = await searchParams

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('id, timezone, profile_completed')
    .eq('auth_user_id', user.id)
    .single()
  if (!student) redirect('/student/login')

  if (student.profile_completed !== true) {
    redirect('/student/account?confirm_tz=1')
  }

  // Get active training
  const { data: training } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, end_date')
    .eq('student_id', student.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!training) {
    // No active training — student cannot book
    redirect('/student/my-classes')
  }

  // Hours remaining
  const hoursRemaining = training.total_hours - training.hours_consumed

  // Get teachers assigned to this training via training_teachers
  const { data: rawAssignments } = await supabase
    .from('training_teachers')
    .select(`
      teacher_id,
      teacher:profiles!teacher_id (
        id,
        full_name,
        photo_url,
        bio,
        timezone
      )
    `)
    .eq('training_id', training.id)

  const teachers = (rawAssignments ?? [])
    .map((row) => {
      const t = Array.isArray(row.teacher) ? row.teacher[0] : row.teacher
      return t ?? null
    })
    .filter(Boolean)

  if (teachers.length === 0) {
    // No teachers assigned yet — redirect back
    redirect('/student/my-classes')
  }

  // If rescheduling, fetch the original lesson
  let rescheduleLesson: {
    id: string
    scheduled_at: string
    duration_minutes: number
    teacher_id: string
  } | null = null

  if (params.reschedule) {
    const { data: lesson } = await supabase
      .from('lessons')
      .select('id, scheduled_at, duration_minutes, teacher_id')
      .eq('id', params.reschedule)
      .eq('student_id', student.id)
      .eq('status', 'scheduled')
      .maybeSingle()
    rescheduleLesson = lesson ?? null
  }

  return (
    <BookingClient
      studentId={student.id}
      studentTimezone={requireTz(student.timezone, 'book:student')}
      trainingId={training.id}
      hoursRemaining={hoursRemaining}
      teachers={teachers}
      rescheduleLesson={rescheduleLesson}
    />
  )
}