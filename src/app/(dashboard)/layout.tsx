// src/app/(dashboard)/layout.tsx
// This runs on the server. It checks the user is logged in, fetches their
// profile from Supabase, then wraps every dashboard page with the
// nav, header, and right panel.

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

  // Check who is logged in
  const { data: { user } } = await supabase.auth.getUser()

  // If nobody is logged in, send them to the login page
  if (!user) {
    redirect('/login')
  }

  // Fetch their profile from the profiles table
  // profiles.id matches the Supabase Auth user id directly
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, email, photo_url, role')
    .eq('id', user.id)
    .single()

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">

      {/* Top header — full width across the top */}
      <TopHeader
        teacherName={profile?.full_name ?? 'Teacher'}
        teacherPhotoUrl={profile?.photo_url ?? null}
      />

      {/* Everything below the header */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left nav — fixed width */}
        <LeftNav userRole={profile?.role ?? 'teacher'} />

        {/* Main content — fills remaining space, scrolls on its own */}
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          {children}
        </main>

        {/* Right panel — fixed width */}
        <RightPanel teacherId={profile?.id ?? null} />

      </div>
    </div>
  )
}