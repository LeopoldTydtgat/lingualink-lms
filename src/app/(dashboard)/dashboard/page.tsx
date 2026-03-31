import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const supabase = await createClient()

  // Get the currently logged-in user
  const { data: { user } } = await supabase.auth.getUser()

  // Safety net — middleware handles this but just in case
  if (!user) redirect('/login')

  // Fetch their profile to get their name and role
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single()

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-black">
        Welcome back, {profile?.full_name || user.email}
      </h1>
      <p className="text-gray-500 mt-1">
        Role: {profile?.role}
      </p>
      <p className="text-sm text-gray-400 mt-4">
        Dashboard coming soon.
      </p>
    </div>
  )
}