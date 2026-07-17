import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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
    .select('id, full_name, role, timezone, profile_completed')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  if (profile.profile_completed !== true) {
    redirect('/account?confirm_tz=1')
  }

  // Fetch existing availability for this teacher
  const { data: availability } = await supabase
    .from('availability')
    .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', profile.id)
    .order('start_at', { ascending: true })

  // Minimum-hours target from settings (service-role admin client). Fail SAFE:
  // any missing/non-numeric value degrades to null — never invent a target.
  const admin = createAdminClient()
  const { data: minHoursRow } = await admin
    .from('settings')
    .select('value')
    .eq('key', 'min_available_hours')
    .single()
  const parsedMinHours = Number(minHoursRow?.value)
  const minAvailableHours = Number.isNaN(parsedMinHours) ? null : parsedMinHours

  return (
    <ScheduleClient
      profile={profile}
      initialAvailability={availability ?? []}
      minAvailableHours={minAvailableHours}
    />
  )
}