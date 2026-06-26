// src/app/(student)/student/layout.tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import StudentLeftNav from '@/components/student/layout/StudentLeftNav'
import StudentTopHeader from '@/components/student/layout/StudentTopHeader'
import StudentRightPanel from '@/components/student/layout/StudentRightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'
import ClassReminderModal from '@/components/student/ClassReminderModal'
import IdleTimeoutWatcher from '@/components/IdleTimeoutWatcher'

export const metadata: Metadata = {
  title: 'LinguaLink Online - Student Portal',
  description: 'Student portal for LinguaLink Online',
}

export default async function StudentDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  const { data: student } = await admin
    .from('students')
    .select('id, full_name, email, photo_url, status, timezone')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')
  if (student.status === 'former' || student.status === 'on_hold') redirect('/student/login')
  const { data: nextLesson } = await supabase
    .from('lessons')
    .select(`
      scheduled_at,
      teams_join_url,
      duration_minutes,
      status,
      teacher:profiles!teacher_id (
        full_name
      )
    `)
    .eq('student_id', student.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const nextLessonTeacherName = nextLesson
    ? (Array.isArray((nextLesson as any).teacher)
        ? (nextLesson as any).teacher[0]?.full_name ?? null
        : (nextLesson as any).teacher?.full_name ?? null)
    : null

  // Separate query for idle timeout class protection — 90-min lookback catches in-progress classes
  const { data: protectedLesson } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('student_id', student.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const { data: training } = await supabase
    .from('trainings')
    .select('total_hours, hours_consumed, end_date')
    .eq('student_id', student.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { count: assignedCount } = await supabase
    .from('assignments')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student.id)

  const { count: completedCount } = await supabase
    .from('exercise_completions')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student.id)
    .not('assignment_id', 'is', null)

  const { count: unreadMessageCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('receiver_id', student.id)
    .is('read_at', null)

  const hoursRemaining = training
    ? Math.max(0, (training.total_hours ?? 0) - (training.hours_consumed ?? 0))
    : 0

  const { data: dismissals } = await supabase
    .from('announcement_dismissals')
    .select('announcement_id')
    .eq('user_id', student.id)
    .eq('user_type', 'student')

  const dismissedIds = (dismissals ?? []).map(
    (d: { announcement_id: string }) => d.announcement_id
  )

  const { data: allAnnouncements } = await supabase
    .from('announcements')
    .select('id, title, message, is_dismissable, target_audience, target_id')
    .eq('is_active', true)

  const announcements: AnnouncementItem[] = (allAnnouncements ?? []).filter((a) => {
    if (dismissedIds.includes(a.id)) return false
    if (a.target_audience === 'everyone') return true
    if (a.target_audience === 'all_students') return true
    if (a.target_audience === 'specific_student' && a.target_id === student.id) return true
    return false
  })

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar runs full height - logo lives here */}
      <StudentLeftNav unreadMessageCount={unreadMessageCount ?? 0} userId={user.id} />

      {/* Right side: header on top, then content row below */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <StudentTopHeader
          studentName={student.full_name}
          photoUrl={student.photo_url ?? null}
        />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <main className="thin-scroll" style={{ flex: 1, overflowY: 'auto', backgroundColor: '#f9fafb' }}>
            <AnnouncementBanner
              announcements={announcements}
              userType="student"
              userId={student.id}
            />
            <div style={{ padding: '32px' }}>
              {children}
            </div>
          </main>
          <StudentRightPanel
            studentId={student.id}
            nextLesson={nextLesson ?? null}
            teacherName={nextLessonTeacherName}
            hoursRemaining={hoursRemaining}
            totalHours={training?.total_hours ?? 0}
            trainingEndDate={training?.end_date ?? null}
            assignedExercises={assignedCount ?? 0}
            completedExercises={completedCount ?? 0}
          />
        </div>
      </div>

      {/* Class reminder modal — renders on all student pages */}
      <ClassReminderModal studentId={student.id} />

      <IdleTimeoutWatcher
        nextLessonStartIso={protectedLesson?.scheduled_at ?? null}
        nextLessonDurationMinutes={protectedLesson?.duration_minutes ?? null}
        loginPath="/student/login"
      />
    </div>
  )
}
