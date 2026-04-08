// src/app/(dashboard)/layout.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LeftNav from '@/components/layout/LeftNav'
import TopHeader from '@/components/layout/TopHeader'
import RightPanel from '@/components/layout/RightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'

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

  // Count messages sent TO this user that haven't been read yet
  // This drives the unread badge on the Messages nav item
  const { count: unreadCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('receiver_id', user.id)
    .is('read_at', null)

  // ── Announcements ───────────────────────────────────────────────────────────
  // Fetch announcements this teacher has already dismissed
  const { data: dismissals } = await supabase
    .from('announcement_dismissals')
    .select('announcement_id')
    .eq('user_id', user.id)
    .eq('user_type', 'teacher')

  const dismissedIds = (dismissals ?? []).map((d: { announcement_id: string }) => d.announcement_id)

  // Fetch active announcements targeting teachers or everyone
  const { data: allAnnouncements } = await supabase
    .from('announcements')
    .select('id, title, message, is_dismissable, target_audience, target_id')
    .eq('is_active', true)

  const now = new Date()

  const announcements: AnnouncementItem[] = (allAnnouncements ?? []).filter((a) => {
    // Already dismissed — skip
    if (dismissedIds.includes(a.id)) return false
    // Audience check
    if (a.target_audience === 'everyone') return true
    if (a.target_audience === 'all_teachers') return true
    if (a.target_audience === 'specific_teacher' && a.target_id === user.id) return true
    return false
  })

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
      <TopHeader
        teacherName={profile?.full_name ?? 'Teacher'}
        teacherPhotoUrl={profile?.photo_url ?? null}
      />
      <div className="flex flex-1 overflow-hidden">
        <LeftNav
          userRole={profile?.role ?? 'teacher'}
          unreadMessageCount={unreadCount ?? 0}
        />
        <main className="flex-1 overflow-y-auto bg-gray-50">
          {/* Announcement banners sit above page content */}
          <AnnouncementBanner
            announcements={announcements}
            userType="teacher"
            userId={user.id}
          />
          <div className="p-6">
            {children}
          </div>
        </main>
        <RightPanel teacherId={profile?.id ?? null} />
      </div>
    </div>
  )
}
