// src/app/(dashboard)/layout.tsx
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getMonthRangeInTz } from '@/lib/billing/monthRange'
import { getBillability, getProjectedAmount } from '@/lib/billing/billability'
import LeftNav from '@/components/layout/LeftNav'
import TopHeader from '@/components/layout/TopHeader'
import RightPanel from '@/components/layout/RightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'
import ChatWidget from '@/components/ChatWidget'
import IdleTimeoutWatcher from '@/components/IdleTimeoutWatcher'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('id, full_name, email, photo_url, role, timezone')
    .eq('id', user.id)
    .single()

  const { data: lessonRow } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, teams_join_url, student_id, status')
    .eq('teacher_id', profile?.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
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
      status: lessonRow.status,
    }
  }

  // Separate query for idle timeout class protection — 90-min lookback catches in-progress classes
  const { data: protectedLesson } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', profile?.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // ── Billing summary for the current calendar month ────────────────────────
  const now = new Date()
  const tz = profile?.timezone ?? 'UTC'
  const { startUtc, endUtc } = getMonthRangeInTz(now, tz)

  const { data: monthLessons } = await supabase
    .from('lessons')
    .select('duration_minutes, status, cancelled_at, scheduled_at')
    .eq('teacher_id', profile?.id)
    .gte('scheduled_at', startUtc)
    .lt('scheduled_at', endUtc)
    .in('status', ['completed', 'student_no_show', 'cancelled', 'cancelled_by_student', 'scheduled'])

  const { data: rateRow } = await admin
    .from('profiles')
    .select('hourly_rate, currency')
    .eq('id', user.id)
    .single()
  const hourlyRate = rateRow?.hourly_rate ?? 0
  const currency = rateRow?.currency ?? null

  let currentAmount = 0
  let projectedAmount = 0

  for (const lesson of monthLessons ?? []) {
    if (lesson.status !== 'scheduled') {
      const bill = getBillability({
        status: lesson.status,
        scheduledAt: lesson.scheduled_at,
        cancelledAt: lesson.cancelled_at,
        cancellationPolicy: null,
        hourlyRate,
        durationMinutes: lesson.duration_minutes,
      })
      if (bill.billableToTeacher) currentAmount += bill.amount
    }
    projectedAmount += getProjectedAmount({
      status: lesson.status,
      scheduledAt: lesson.scheduled_at,
      cancelledAt: lesson.cancelled_at,
      cancellationPolicy: null,
      hourlyRate,
      durationMinutes: lesson.duration_minutes,
    })
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
    .limit(1)
    .maybeSingle()

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
        userId={user.id}
      />

      {/* Right side: header on top, then content row below */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopHeader
          teacherName={profile?.full_name ?? 'Teacher'}
          teacherPhotoUrl={profile?.photo_url ?? null}
        />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto bg-gray-50 thin-scroll">
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
            currency={currency}
          />
        </div>
      </div>

      {profile?.role !== 'admin' && (
        <ChatWidget
          participantId={profile?.id ?? ''}
          participantType="teacher"
          participantAuthId={user.id}
          adminName={adminProfile?.full_name ?? 'Shannon'}
          adminPhotoUrl={adminProfile?.photo_url ?? null}
        />
      )}

      <IdleTimeoutWatcher
        nextLessonStartIso={protectedLesson?.scheduled_at ?? null}
        nextLessonDurationMinutes={protectedLesson?.duration_minutes ?? null}
        loginPath="/login"
      />
    </div>
  )
}
