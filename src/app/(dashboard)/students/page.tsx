import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import StudentsClient from './StudentsClient'

export default async function StudentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get current user's profile to check role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const isAdmin = profile?.role === 'admin'

  const adminClient = createAdminClient()
  const now = new Date()

  // Fetch trainings via the service-role client so the JS access gate below, not RLS, decides
  // visibility. training_teachers is the canonical assignment record; trainings.teacher_id is a
  // dead legacy column the post-migration code never writes, so it must never filter this list.
  // Admin sees every training; a teacher is gated by the union of Conditions A and B further down.
  const { data: trainings, error } = await adminClient
    .from('trainings')
    .select(`
      id,
      status,
      total_hours,
      hours_consumed,
      start_date,
      end_date,
      package_type,
      teacher_id,
      students (
        id,
        full_name,
        photo_url,
        self_assessed_level
      ),
      profiles!trainings_teacher_id_fkey (
        id,
        full_name
      ),
      training_teachers (
        teacher_id
      )
    `)
    .order('start_date', { ascending: false })

  if (error) {
    console.error('Error fetching trainings:', error)
  }

  // Condition B (substitute / active teaching), computed for teachers only. A training is visible
  // when this teacher has a lesson on it that is either upcoming-scheduled, or still carries an
  // open report (pending in-window, or reopened until completed). Anchored strictly on
  // lessons.teacher_id, so a lesson that was reassigned away never leaks its training to a former teacher.
  const activeTrainingIds = new Set<string>()
  if (!isAdmin) {
    const { data: myLessons } = await adminClient
      .from('lessons')
      .select('id, training_id, status, scheduled_at')
      .eq('teacher_id', user.id)

    type LessonRow = { id: string; training_id: string; status: string; scheduled_at: string | null }
    const lessonRows = (myLessons ?? []) as LessonRow[]

    // B1: an upcoming scheduled lesson keeps the training visible.
    for (const l of lessonRows) {
      if (l.status === 'scheduled' && l.scheduled_at && new Date(l.scheduled_at) > now) {
        activeTrainingIds.add(l.training_id)
      }
    }

    // B2: an open report on one of this teacher's lessons keeps the training visible. A 'pending'
    // report counts only while inside its window (deadline_at > now); a 'reopened' report counts
    // until it is completed - its deadline_at is stale (set once at creation, never refreshed on
    // reopen), so the window check is skipped for it. Matched only against this teacher's own
    // lessons (lesson_id in their lesson set), never by report owner.
    const myLessonIds = lessonRows.map(l => l.id)
    if (myLessonIds.length > 0) {
      const lessonToTraining = new Map<string, string>(
        lessonRows.map(l => [l.id, l.training_id] as [string, string])
      )
      const { data: openReports } = await adminClient
        .from('reports')
        .select('lesson_id, status, deadline_at')
        .in('lesson_id', myLessonIds)
        .in('status', ['pending', 'reopened'])

      type ReportRow = { lesson_id: string; status: string; deadline_at: string | null }
      for (const r of ((openReports ?? []) as ReportRow[])) {
        if (r.status === 'reopened' || (r.deadline_at && new Date(r.deadline_at) > now)) {
          const tid = lessonToTraining.get(r.lesson_id)
          if (tid) activeTrainingIds.add(tid)
        }
      }
    }
  }

  // Supabase returns nested joins as arrays â€" flatten students and profiles to single objects
  const flatTrainings = (trainings ?? []).map(t => ({
    ...t,
    students: Array.isArray(t.students) ? t.students[0] : t.students,
    profiles: Array.isArray(t.profiles) ? t.profiles[0] : t.profiles,
  }))

  // Access gate: a teacher sees a training only via Condition A (formal junction assignment) or
  // Condition B (active teaching, computed above). The service-role fetch bypassed RLS, so this
  // union filter is the SOLE access control for teachers. Admin keeps every training.
  const visibleTrainings = isAdmin
    ? flatTrainings
    : flatTrainings.filter((t: { id: string; training_teachers?: { teacher_id: string }[] }) => {
        // Condition A: formal assignment recorded in the training_teachers junction.
        const teacherRows = Array.isArray(t.training_teachers) ? t.training_teachers : []
        const isAssigned = teacherRows.some(tt => tt.teacher_id === user.id)
        // Condition B: substitute / active-teaching access computed from lessons and reports.
        return isAssigned || activeTrainingIds.has(t.id)
      })

  // Split into current and past
  const currentTrainings = visibleTrainings.filter((t: { end_date: string | null }) => !t.end_date || new Date(t.end_date) >= now)
  const pastTrainings = visibleTrainings.filter((t: { end_date: string | null }) => t.end_date && new Date(t.end_date) < now)

  return (
    <StudentsClient
      currentTrainings={currentTrainings}
      pastTrainings={pastTrainings}
      isAdmin={isAdmin}
    />
  )
}
