import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import BookingFlowClient from './BookingFlowClient'

export default async function AdminNewClassPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) redirect('/dashboard')

  // Fetch all active teachers for Step 1 selection
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name, photo_url, bio, timezone')
    .contains('account_types', ['teacher'])
    .eq('is_active', true)
    .order('full_name')

  // Fetch all active students with their active training for hours check
  const { data: students } = await supabase
    .from('students')
    .select(`
      id,
      full_name,
      photo_url,
      timezone,
      trainings (
        id,
        total_hours,
        hours_consumed,
        package_name,
        status
      )
    `)
    .eq('is_active', true)
    .order('full_name')

  // Flatten trainings — take the first active training per student
  const studentsWithTraining = (students ?? []).map((s) => {
    const trainingRaw = Array.isArray(s.trainings) ? s.trainings : [s.trainings]
    const activeTraining = trainingRaw.find((t: any) => t?.status === 'active') ?? trainingRaw[0] ?? null
    return {
      id: s.id,
      full_name: s.full_name,
      photo_url: s.photo_url,
      timezone: s.timezone,
      training: activeTraining,
    }
  })

  return (
    <BookingFlowClient
      teachers={teachers ?? []}
      students={studentsWithTraining}
    />
  )
}
