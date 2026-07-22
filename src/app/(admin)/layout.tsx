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

export interface RightPanelStats {
  classesTodayCount: number | null
  pendingCount: number
  flaggedCount: number
  lowHoursCount: number
  invoicesToReviewCount: number
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

  const { data: profile } = await adminDb
    .from('profiles')
    .select('id, full_name, role, account_types, photo_url, timezone')
    .eq('id', user.id)
    .single()

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

  const [
    todayRes,
    pendingRes,
    flaggedRes,
    trainingsRes,
    invoicesRes,
    announcementRes,
    unreadMessagesRes,
    unreadSupportRes,
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
      .select('total_hours, hours_consumed')
      .eq('status', 'active'),

    // Invoices uploaded but not yet marked paid — admin-only widget, skipped for staff
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'uploaded'),

    // First active announcement text (if any) — admin-only panel card, skipped for staff
    isStaffView
      ? Promise.resolve(null)
      : adminDb
          .from('announcements')
          .select('message')
          .eq('is_active', true)
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
  ])

  const classesTodayCount = timezoneMissing
    ? null
    : (todayRes?.data ?? []).filter(
        (l) => !isCancelledStatus(l.status)
      ).length

  const lowHoursCount = (trainingsRes.data ?? []).filter(
    (t) => Number(t.total_hours) - Number(t.hours_consumed) < 2
  ).length

  const rightPanelStats: RightPanelStats = {
    classesTodayCount,
    pendingCount:          pendingRes?.count  ?? 0,
    flaggedCount:          flaggedRes?.count  ?? 0,
    lowHoursCount,
    invoicesToReviewCount: invoicesRes?.count ?? 0,
    activeAnnouncementText: announcementRes?.data?.message ?? null,
  }

  const unreadMessagesCount = unreadMessagesRes?.count ?? 0
  const unreadSupportCount = unreadSupportRes.count ?? 0

  // ── protected lesson for idle timeout — 90-min lookback catches in-progress classes ─
  const { data: protectedLesson } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', profile.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (
    <AdminLayoutClient
      profile={profile}
      rightPanelStats={rightPanelStats}
      unreadMessagesCount={unreadMessagesCount}
      unreadSupportCount={unreadSupportCount}
      protectedLesson={protectedLesson ?? null}
      isStaffView={isStaffView}
    >
      {children}
    </AdminLayoutClient>
  )
}
