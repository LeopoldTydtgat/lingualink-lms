import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireStaff } from '@/lib/auth/requireStaff'
import AdminLayoutClient from './AdminLayoutClient'
import { isCancelledStatus } from '@/lib/billing/billability'
import { getDayRangeInTz } from '@/lib/billing/monthRange'

export const metadata: Metadata = {
  title: 'LinguaLink Online - Admin Portal',
  description: 'Admin portal for LinguaLink Online',
}

// Every count is nullable because a failed query must not render as a confident
// "0". timezoneMissing disambiguates the two reasons classesTodayCount can be
// null: no admin timezone (prompt to set one) vs a query that failed (dash).
export interface RightPanelStats {
  classesTodayCount: number | null
  timezoneMissing: boolean
  pendingCount: number | null
  flaggedCount: number | null
  lowHoursCount: number | null
  invoicesToReviewCount: number | null
  activeAnnouncementText: string | null
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminDb = createAdminClient()

  // A query error and a genuinely missing row are different failures: the first is
  // transient and must surface, the second is a real "no profile" state. Discarding
  // the error made both look like null and bounced the user to /login.
  const { data: profile, error: profileError } = await adminDb
    .from('profiles')
    .select('id, full_name, role, account_types, photo_url, timezone')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[admin/layout] profiles lookup failed:', profileError)
    throw new Error('Failed to load profile')
  }
  if (!profile) redirect('/login?error=profile_error')

  // Staff-or-admin gate (ROLE-5b): role 'admin', or account_types contains
  // 'staff' with status 'current'. Per-page gates decide anything finer.
  const staffUser = await requireStaff()
  if (!staffUser) redirect('/dashboard')

  // requireStaff already admitted the user; anyone here who is not role 'admin'
  // is staff. Staff get a trimmed shell: fewer nav items, fewer panel widgets,
  // so the stats those widgets would show are skipped server-side below.
  const isStaffView = profile.role !== 'admin'

  // The viewing admin's own timezone, used for all "today" bucketing; null/empty means unset.
  const adminTimezone = profile.timezone ?? 'UTC'
  const timezoneMissing = !profile.timezone

  // ── right panel stats ─────────────────────────────────────────────────────
  // Today range only when we have the admin's real timezone — never guess UTC, which would
  // mis-bucket which lessons count as "today". When missing we skip the bucketed query
  // (resolve null) and surface a null count instead.
  const todayRange = timezoneMissing ? null : getDayRangeInTz(new Date(), adminTimezone)

  const announcementNowIso = new Date().toISOString()

  const [
    todayRes,
    pendingRes,
    flaggedRes,
    trainingsRes,
    invoicesRes,
    announcementRes,
    unreadMessagesRes,
    unreadSupportRes,
    protectedLessonRes,
  ] = await Promise.all([
    // Classes today (excluding cancelled), only when a real timezone is present; else null
    todayRange
      ? adminDb
          .from('lessons')
          .select('id, status')
          .gte('scheduled_at', todayRange.startUtc)
          .lt('scheduled_at', todayRange.endUtc)
      : Promise.resolve(null),

    // Pending reports — admin-only widget, skipped for staff
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('reports')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'reopened']),

    // Flagged reports — admin-only widget, skipped for staff
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('reports')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'flagged'),

    // Active trainings — for low hours count (balance < 2h)
    adminDb
      .from('trainings')
      .select('total_hours, hours_consumed, student_id')
      .eq('status', 'active'),

    // Invoices uploaded but not yet marked paid — admin-only widget, skipped for staff
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'uploaded'),

    // First active announcement text (if any) — admin-only panel card, skipped for staff
    // start_date/end_date are stored as UTC-pinned instants by AnnouncementForm
    // (`T00:00:00.000Z` / `T23:59:59.000Z`); null means unbounded on that side.
    // The two .or() filters AND together in PostgREST, so a scheduled row stays
    // hidden until its start and an expired row drops out after its end.
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('announcements')
          .select('message')
          .eq('is_active', true)
          .or(`start_date.is.null,start_date.lte.${announcementNowIso}`)
          .or(`end_date.is.null,end_date.gte.${announcementNowIso}`)
          .limit(1)
          .maybeSingle(),

    // Unread message count for the nav badge — student-involving conversations only,
    // mirroring the admin Messages page's own unread computation. Staff have no
    // Messages nav item, so skipped for staff.
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .is('admin_read_at', null)
          .or('sender_type.eq.student,receiver_type.eq.student'),

    // Unread support messages count for the Support nav badge
    adminDb
      .from('support_messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_role', 'user')
      .is('read_at', null),

    // ── protected lesson for idle timeout — 90-min lookback catches in-progress classes ─
    supabase
      .from('lessons')
      .select('scheduled_at, duration_minutes')
      .eq('teacher_id', profile.id)
      .eq('status', 'scheduled')
      .gt('scheduled_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  // Each result's error was previously discarded, so a failed query rendered as a
  // confident "0" — indistinguishable from a real zero. Log every failure under its
  // own tag; the values below then fall to null so the rail can show a dash.
  if (todayRes?.error) console.error('[admin/layout] lessons-today query failed:', todayRes.error)
  if (pendingRes?.error) console.error('[admin/layout] reports-pending query failed:', pendingRes.error)
  if (flaggedRes?.error) console.error('[admin/layout] reports-flagged query failed:', flaggedRes.error)
  if (trainingsRes.error) console.error('[admin/layout] trainings-low-hours query failed:', trainingsRes.error)
  if (invoicesRes?.error) console.error('[admin/layout] invoices-review query failed:', invoicesRes.error)
  if (announcementRes?.error) console.error('[admin/layout] announcements-active query failed:', announcementRes.error)
  if (unreadMessagesRes?.error) console.error('[admin/layout] messages-unread query failed:', unreadMessagesRes.error)
  if (unreadSupportRes.error) console.error('[admin/layout] support-unread query failed:', unreadSupportRes.error)

  const classesTodayCount =
    timezoneMissing || todayRes?.error
      ? null
      : (todayRes?.data ?? []).filter(
          (l) => !isCancelledStatus(l.status)
        ).length

  // distinct students, not training/lesson rows - a student can hold multiple active trainings
  const lowHoursCount = trainingsRes.error
    ? null
    : new Set(
        (trainingsRes.data ?? [])
          .filter((t) => Number(t.total_hours) - Number(t.hours_consumed) < 2)
          .map((t) => t.student_id)
          .filter(Boolean)
      ).size

  const rightPanelStats: RightPanelStats = {
    classesTodayCount,
    timezoneMissing,
    // null means either "skipped for staff" (the widget is filtered out anyway) or
    // "query failed" (the widget renders a dash). Neither may show as 0.
    pendingCount:          pendingRes  && !pendingRes.error  ? pendingRes.count  ?? 0 : null,
    flaggedCount:          flaggedRes  && !flaggedRes.error  ? flaggedRes.count  ?? 0 : null,
    lowHoursCount,
    invoicesToReviewCount: invoicesRes && !invoicesRes.error ? invoicesRes.count ?? 0 : null,
    activeAnnouncementText: announcementRes?.data?.message ?? null,
  }

  // Badge counts keep ?? 0 deliberately: a dash inside a nav count badge tells the
  // user nothing actionable, and Realtime resyncs the true count on the next event.
  const unreadMessagesCount = unreadMessagesRes?.count ?? 0
  const unreadSupportCount = unreadSupportRes.count ?? 0

  return (
    <AdminLayoutClient
      profile={profile}
      rightPanelStats={rightPanelStats}
      unreadMessagesCount={unreadMessagesCount}
      unreadSupportCount={unreadSupportCount}
      protectedLesson={protectedLessonRes.data ?? null}
      isStaffView={isStaffView}
    >
      {children}
    </AdminLayoutClient>
  )
}
