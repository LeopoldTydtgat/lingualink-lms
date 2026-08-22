import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/auth/requireStaff'
import { redirect } from 'next/navigation'
import ClassesListClient from './ClassesListClient'
import { getDayKeyInTz } from '@/lib/billing/monthRange'
import { getMonthToDateRange } from '@/lib/dates/dateRangePresets'

export default async function AdminClassesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  // Stat-card deep link (/admin/classes?filter=today) pins the From/To date filters to
  // that single day. Every other landing - no param, or a value this page does not
  // recognise - opens on the month-to-date default below.
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

  // ONE clock read, shared by both seeds below. Two separate `new Date()` calls either
  // side of a local midnight could let the ?filter=today seed and the month-to-date
  // default that Clear returns to name different days - a narrow window, but the kind
  // this project closes rather than reasons about.
  const now = new Date()

  // The landing range, and the range the client's Clear button hands back: the 1st of
  // the admin's current calendar month through their today. getMonthToDateRange resolves
  // both ends through the same getDayKeyInTz the ?filter=today seed uses, so the deep
  // link and the default agree on which day "today" is by construction.
  //
  // Computed HERE, per request, and deliberately never stored: a month-to-date range
  // written down would name the wrong month the first time a session crossed a month
  // boundary. That is the same reasoning that took the date range out of the client's
  // sessionStorage record entirely.
  //
  // With no timezone on the profile there is no honest answer to "which day is today"
  // — the dashboard card renders "Set timezone" rather than a count for exactly this
  // reason — so BOTH the default and the ?filter=today seed stay empty rather than
  // guessing UTC and naming the wrong day, or the wrong month, for most of the world.
  const monthToDate = profile?.timezone
    ? getMonthToDateRange(now, profile.timezone)
    : { from: '', to: '' }

  // "Today" is the admin's own local day, resolved through getDayKeyInTz — the same
  // ymdInTz bucketing getDayRangeInTz gives the dashboard's Classes Today count, so
  // the card and the list it links to agree on which day "today" is.
  const todayKey =
    filter === 'today' && profile?.timezone
      ? getDayKeyInTz(now, profile.timezone)
      : ''

  // What the list OPENS on. Only ?filter=today narrows to a single day; every other
  // landing gets month-to-date. A timezone-less profile lands on no date filter through
  // either arm, because both are '' for it.
  const initialDateFrom = filter === 'today' ? todayKey : monthToDate.from
  const initialDateTo = filter === 'today' ? todayKey : monthToDate.to

  return (
    <ClassesListClient
      teachers={teachers ?? []}
      initialDateFrom={initialDateFrom}
      initialDateTo={initialDateTo}
      // The landing default, passed as its own pair because it and the two above
      // DISAGREE under ?filter=today: that deep link opens on one day, but Clear must
      // return the admin to month-to-date rather than to the deep link's range.
      defaultDateFrom={monthToDate.from}
      defaultDateTo={monthToDate.to}
      adminTz={profile?.timezone ?? null}
      // Presence of the param, not the seed it produced: ?filter=today on a
      // timezone-less profile (and any unrecognised ?filter= value) still means the URL
      // spoke, so the client must not restore a remembered teacher or status over the
      // top of it. `filter === ''` counts, `undefined` does not. `filter` is the only
      // param this page reads.
      hasUrlFilters={filter !== undefined}
    />
  )
}
