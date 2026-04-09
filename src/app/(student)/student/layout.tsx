// src/app/(student)/student/layout.tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import StudentLeftNav from '@/components/student/layout/StudentLeftNav'
import StudentTopHeader from '@/components/student/layout/StudentTopHeader'
import StudentRightPanel from '@/components/student/layout/StudentRightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'
import ChatWidget, { STUDENT_FAQS } from '@/components/ChatWidget'
import { sendMessage, markMessagesAsRead } from '@/app/(student)/student/messages/actions'

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

  // Admin profile ID — used by ChatWidget to pre-connect to Shannon's conversation
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('id, full_name, photo_url')
    .eq('role', 'admin')
    .single()

  // ── Announcements ────────────────────────────────────────────────────────
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
          }}
        >
          <AnnouncementBanner
            announcements={announcements}
            userType="student"
            userId={student.id}
          />
          <div style={{ padding: '32px' }}>
            {children}
          </div>
        </main>
        {/* Help & Support section removed from StudentRightPanel —
            the ChatWidget floating bubble handles it now */}
        <StudentRightPanel
          studentId={student.id}
          nextLesson={nextLesson ?? null}
          hoursRemaining={hoursRemaining}
          trainingEndDate={training?.end_date ?? null}
          assignedExercises={assignedCount ?? 0}
          completedExercises={completedCount ?? 0}
        />
      </div>
      {/* Floating chat widget — student portal server actions passed as props */}
      <ChatWidget
        currentUserId={student.id}
        currentUserName={student.full_name}
        adminProfileId={adminProfile?.id ?? null}
        adminName={adminProfile?.full_name ?? 'Admin'}
        adminPhotoUrl={adminProfile?.photo_url ?? null}
        faqs={STUDENT_FAQS}
        sendMessageAction={sendMessage}
        markAsReadAction={markMessagesAsRead}
      />
    </div>
  )
}
