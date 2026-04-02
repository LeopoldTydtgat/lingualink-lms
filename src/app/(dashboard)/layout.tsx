// src/app/(dashboard)/layout.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LeftNav from '@/components/layout/LeftNav'
import TopHeader from '@/components/layout/TopHeader'
import RightPanel from '@/components/layout/RightPanel'

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
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          {children}
        </main>
        <RightPanel teacherId={profile?.id ?? null} />
      </div>
    </div>
  )
}