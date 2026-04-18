import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import AdminLayoutClient from './AdminLayoutClient'

// ── date helpers ──────────────────────────────────────────────────────────────
// Never use toISOString() for local date construction.

function utcTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000Z`
  )
}

function getTodayUTCRange() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return { start: utcTimestamp(start), end: utcTimestamp(end) }
}

export interface RightPanelStats {
  classesTodayCount: number
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
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, photo_url')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') redirect('/dashboard')

  // ── right panel stats ─────────────────────────────────────────────────────
  const { start: todayStart, end: todayEnd } = getTodayUTCRange()

  const adminDb = createAdminClient()

  const [
    todayRes,
    pendingRes,
    flaggedRes,
    trainingsRes,
    invoicesRes,
    announcementRes,
    unreadMessagesRes,
  ] = await Promise.all([
    // Classes today (excluding cancelled)
    supabase
      .from('lessons')
      .select('id, status')
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', todayEnd),

    // Pending reports
    supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),

    // Flagged reports
    supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'flagged'),

    // Active trainings — for low hours count (balance < 2h)
    supabase
      .from('trainings')
      .select('total_hours, hours_consumed')
      .eq('status', 'active'),

    // Invoices uploaded but not yet marked paid
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'uploaded'),

    // First active announcement text (if any)
    supabase
      .from('announcements')
      .select('message')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),

    // Platform-wide unread message count for the nav badge
    adminDb
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null),
  ])

  const classesTodayCount = (todayRes.data ?? []).filter(
    (l) => l.status !== 'cancelled'
  ).length

  const lowHoursCount = (trainingsRes.data ?? []).filter(
    (t) => Number(t.total_hours) - Number(t.hours_consumed) < 2
  ).length

  const rightPanelStats: RightPanelStats = {
    classesTodayCount,
    pendingCount:          pendingRes.count  ?? 0,
    flaggedCount:          flaggedRes.count  ?? 0,
    lowHoursCount,
    invoicesToReviewCount: invoicesRes.count ?? 0,
    activeAnnouncementText: announcementRes.data?.message ?? null,
  }

  const unreadMessagesCount = unreadMessagesRes.count ?? 0

  return (
    <AdminLayoutClient
      profile={profile}
      rightPanelStats={rightPanelStats}
      unreadMessagesCount={unreadMessagesCount}
    >
      {children}
    </AdminLayoutClient>
  )
}
