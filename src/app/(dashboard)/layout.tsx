// src/app/(dashboard)/layout.tsx
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import LeftNav from '@/components/layout/LeftNav'
import TopHeader from '@/components/layout/TopHeader'
import RightPanel from '@/components/layout/RightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'
import ChatWidget, { TEACHER_FAQS } from '@/components/ChatWidget'
import { sendMessage, markMessagesAsRead } from '@/app/(dashboard)/messages/actions'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, email, photo_url, role')
    .eq('id', user.id)
    .single()

  const { data: lessonRow } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, teams_join_url, student_id')
    .eq('teacher_id', profile?.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  let nextLesson = null

  if (lessonRow) {
    const { data: studentRow } = await supabase
      .from('students')
      .select('full_name')
      .eq('id', lessonRow.student_id)
      .single()

    nextLesson = {
      id: lessonRow.id,
      scheduled_at: lessonRow.scheduled_at,
      duration_minutes: lessonRow.duration_minutes,
      teams_join_url: lessonRow.teams_join_url,
      student_name: studentRow?.full_name ?? 'Student',
    }
  }

  // ── Billing summary for the current calendar month ────────────────────────
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const { data: monthLessons } = await supabase
    .from('lessons')
    .select('duration_minutes, status')
    .eq('teacher_id', profile?.id)
    .gte('scheduled_at', monthStart)
    .in('status', ['completed', 'student_no_show', 'scheduled'])

  const admin = createAdminClient()
  const { data: rateRow } = await admin
    .from('profiles')
    .select('hourly_rate')
    .eq('id', user.id)
    .single()
  const hourlyRate = rateRow?.hourly_rate ?? 0

  let currentAmount = 0
  let projectedAmount = 0

  for (const lesson of monthLessons ?? []) {
    const amount = (lesson.duration_minutes / 60) * hourlyRate
    if (lesson.status === 'completed' || lesson.status === 'student_no_show') {
      currentAmount += amount
    }
    projectedAmount += amount
  }

  const billingData = { currentAmount, projectedAmount }

  const { count: unreadCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('receiver_id', user.id)
    .is('read_at', null)

  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('id, full_name, photo_url')
    .eq('role', 'admin')
    .single()

  const { data: dismissals } = await supabase
    .from('announcement_dismissals')
    .select('announcement_id')
    .eq('user_id', user.id)
    .eq('user_type', 'teacher')

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
    if (a.target_audience === 'all_teachers') return true
    if (a.target_audience === 'specific_teacher' && a.target_id === user.id) return true
    return false
  })

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      {/* Sidebar runs full height - logo lives here */}
      <LeftNav
        userRole={profile?.role ?? 'teacher'}
        unreadMessageCount={unreadCount ?? 0}
      />

      {/* Right side: header on top, then content row below */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopHeader
          teacherName={profile?.full_name ?? 'Teacher'}
          teacherPhotoUrl={profile?.photo_url ?? null}
        />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto bg-gray-50">
            <AnnouncementBanner
              announcements={announcements}
              userType="teacher"
              userId={user.id}
            />
            <div className="p-6">
              {children}
            </div>
          </main>
          <RightPanel
            teacherId={profile?.id ?? null}
            announcements={announcements}
            nextLesson={nextLesson}
            billingData={billingData}
          />
        </div>
      </div>

      <ChatWidget
        currentUserId={profile?.id ?? ''}
        currentUserName={profile?.full_name ?? 'Teacher'}
        adminProfileId={adminProfile?.id ?? null}
        adminName={adminProfile?.full_name ?? 'Admin'}
        adminPhotoUrl={adminProfile?.photo_url ?? null}
        faqs={TEACHER_FAQS}
        sendMessageAction={sendMessage}
        markAsReadAction={markMessagesAsRead}
      />
    </div>
  )
}
