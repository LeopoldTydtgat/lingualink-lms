import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ScheduleClient from './ScheduleClient'

export default async function SchedulePage() {
  const supabase = await createClient()

  // Check the user is logged in
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get the teacher's profile so we know their role and id
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  // Fetch existing availability for this teacher
  const { data: availability } = await supabase
    .from('availability')
    .select('*')
    .eq('teacher_id', profile.id)
    .order('created_at', { ascending: true })

  return (
    <ScheduleClient
      profile={profile}
      initialAvailability={availability ?? []}
    />
  )
}