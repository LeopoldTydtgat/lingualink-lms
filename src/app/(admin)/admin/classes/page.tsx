import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/auth/requireStaff'
import { redirect } from 'next/navigation'
import ClassesListClient from './ClassesListClient'
import { getDayKeyInTz } from '@/lib/billing/monthRange'

export default async function AdminClassesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  // Stat-card deep link (/admin/classes?filter=today) seeds the From/To date
  // filters. Anything else leaves both empty (no date filter).
  const { filter } = await searchParams

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const staffUser = await requireStaff()
  if (!staffUser) redirect('/dashboard')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, timezone')
    .eq('id', user.id)
    .maybeSingle()

  // Fetch teacher list for the filter dropdown
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .contains('account_types', ['teacher'])
    .eq('status', 'current')
    .order('full_name')

  // "Today" is the admin's own local day, resolved through getDayKeyInTz — the same
  // ymdInTz bucketing getDayRangeInTz gives the dashboard's Classes Today count, so
  // the card and the list it links to agree on which day "today" is.
  // With no timezone on the profile we cannot honestly name a day (the dashboard card
  // renders "Set timezone" rather than a count for exactly this reason), so leave the
  // filter unset instead of guessing UTC and seeding the wrong date.
  const todayKey =
    filter === 'today' && profile?.timezone
      ? getDayKeyInTz(new Date(), profile.timezone)
      : ''

  return (
    <ClassesListClient
      teachers={teachers ?? []}
      initialDateFrom={todayKey}
      initialDateTo={todayKey}
    />
  )
}
