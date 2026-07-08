import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import DashboardClient from './DashboardClient'
import { isCancelledStatus, CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { getDayRangeInTz } from '@/lib/billing/monthRange'

// ── date helpers ──────────────────────────────────────────────────────────────
// Never use toISOString() for local date construction.
// All UTC timestamp strings for DB queries are built manually here.

function utcTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000Z`
  )
}

// Build a 'Wed 18 Jun' style label in the given timezone (deterministic — no
// hydration risk; Intl with an explicit timeZone yields the same output on
// server and client).
function buildLabelInTz(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(date)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const day = parts.find(p => p.type === 'day')?.value ?? ''
  const month = parts.find(p => p.type === 'month')?.value ?? ''
  return `${weekday} ${day} ${month}`
}

// ── nested join flattener ─────────────────────────────────────────────────────
// Supabase can return joined relations as arrays or objects — always flatten safely.
function flatRel<T>(val: T | T[] | null | undefined): T | null {
  if (val == null) return null
  return Array.isArray(val) ? (val[0] ?? null) : val
}

// ── exported types (used by DashboardClient) ──────────────────────────────────
export interface DashboardStats {
  classesTodayCount: number | null  // null when the admin has no timezone set (today can't be bucketed)
  pendingCount: number
  flaggedCount: number
  lowHoursCount: number
  invoicesToReviewCount: number
  activeAnnouncementsCount: number
}

export interface LiveLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  teacher_name: string
  student_name: string
}

export interface PendingReportItem {
  id: string
  status: 'pending' | 'flagged' | 'reopened'
  deadline_at: string | null
  lesson_scheduled_at: string
  lesson_duration: number
  teacher_name: string
  student_name: string
}

export interface AlertLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teacher_name: string
  student_name: string
}

export const dynamic = 'force-dynamic'

// ── page ──────────────────────────────────────────────────────────────────────
export default async function AdminDashboardPage() {
  // Identify the logged-in admin (the admin layout has already gated access) and read their
  // timezone, so every date/time below renders in the admin's own zone, not a hardcoded SAST
  // offset. The service-role client below is for data; this cookie client only learns who is
  // viewing.
  const cookieClient = await createClient()
  const { data: { user } } = await cookieClient.auth.getUser()
  const { data: adminProfile } = user
    ? await cookieClient.from('profiles').select('timezone').eq('id', user.id).maybeSingle()
    : { data: null }

  // If the admin has no timezone set, fall back to UTC and flag it so the client shows a
  // warning banner. Never silently guess a zone, and never block the dashboard over a
  // missing profile field.
  const adminTimezone = adminProfile?.timezone ?? 'UTC'
  const timezoneMissing = !adminProfile?.timezone

  const supabase = createAdminClient()

  // Today range ONLY when we have the admin's real timezone. With no timezone we must not guess
  // UTC — that would mis-bucket which lessons count as "today" (the count AND the feed), not
  // merely mislabel display. When the timezone is missing we skip the bucketed query entirely
  // (resolve null) and surface a "set your timezone" prompt instead (classesTodayCount = null).
  const todayRange = timezoneMissing ? null : getDayRangeInTz(new Date(), adminTimezone)
  const now = new Date()
  const nowStr = utcTimestamp(now)
  const in24hStr = utcTimestamp(new Date(now.getTime() + 24 * 60 * 60 * 1000))

  // ── run all queries in parallel ───────────────────────────────────────────
  const [
    todayRes,
    pendingRes,
    flaggedRes,
    flaggedCountRes,
    trainingsRes,
    invoicesRes,
    announcementsRes,
    missingTeamsRes,
  ] = await Promise.all([
    // Today's lessons (live classes feed) — bucketed to the admin's own local day. Runs only
    // when a real timezone is present; otherwise resolves to null and the panel shows a prompt.
    todayRange
      ? supabase
          .from('lessons')
          .select(`
            id, scheduled_at, duration_minutes, status,
            teacher:profiles!teacher_id(full_name),
            student:students!student_id(full_name)
          `)
          .gte('scheduled_at', todayRange.startUtc)
          .lt('scheduled_at', todayRange.endUtc)
          .order('scheduled_at')
      : Promise.resolve(null),

    // Outstanding reports (pending + admin-reopened) — feeds the pending panel and count.
    // A 'reopened' report is awaiting the teacher's late submission just like 'pending', so it
    // belongs in the same "outstanding / awaiting teacher" bucket (NEW270).
    supabase
      .from('reports')
      .select(`
        id, status, deadline_at,
        teacher:profiles!teacher_id(full_name),
        lesson:lessons!lesson_id(
          scheduled_at, duration_minutes,
          student:students!student_id(full_name)
        )
      `)
      .in('status', ['pending', 'reopened'])
      .order('deadline_at'),

    // Flagged reports (same shape — shown first in pending panel, in red)
    supabase
      .from('reports')
      .select(`
        id, status, deadline_at,
        teacher:profiles!teacher_id(full_name),
        lesson:lessons!lesson_id(
          scheduled_at, duration_minutes,
          student:students!student_id(full_name)
        )
      `)
      .eq('status', 'flagged')
      .order('flagged_at', { ascending: false }),

    // Flagged count for the stat card
    supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'flagged'),

    // Active trainings — used to compute low-hours and zero-balance counts
    supabase
      .from('trainings')
      .select('id, student_id, total_hours, hours_consumed')
      .eq('status', 'active'),

    // Invoices awaiting review (uploaded but not yet marked paid)
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'uploaded'),

    // Active announcements — first one's text shown in dashboard banner
    supabase
      .from('announcements')
      .select('id, title, message')
      .eq('is_active', true),

    // Alert: classes in next 24h with no Teams link (Graph API failure)
    // nowStr / in24hStr are UTC instants — correct as-is for these future-lesson comparisons
    supabase
      .from('lessons')
      .select(`
        id, scheduled_at, duration_minutes,
        teacher:profiles!teacher_id(full_name),
        student:students!student_id(full_name)
      `)
      .gt('scheduled_at', nowStr)
      .lte('scheduled_at', in24hStr)
      .is('teams_join_url', null)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES)),
  ])

  // ── error detection ───────────────────────────────────────────────────────
  // Any query error (transient failure, Hobby-plan timeout, RLS denial) must surface
  // as a dashboard-level error rather than silently rendering zeros for all stats.
  const hasError = !!(
    todayRes?.error      ||
    pendingRes.error     ||
    flaggedRes.error     ||
    flaggedCountRes.error ||
    trainingsRes.error   ||
    invoicesRes.error    ||
    announcementsRes.error ||
    missingTeamsRes.error
  )

  // ── compute low-hours and zero-balance counts ─────────────────────────────
  const trainings = trainingsRes.data ?? []

  const lowHoursCount = trainings.filter(
    (t) => Number(t.total_hours) - Number(t.hours_consumed) < 2
  ).length

  // Find student IDs with zero balance, then check if any have upcoming classes
  const zeroIds = trainings
    .filter((t) => Number(t.total_hours) - Number(t.hours_consumed) <= 0)
    .map((t) => t.student_id)
    .filter(Boolean)

  let zeroBalanceWithClassesCount = 0
  if (zeroIds.length > 0) {
    const { count } = await supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .in('student_id', zeroIds)
      .gt('scheduled_at', nowStr)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
    zeroBalanceWithClassesCount = count ?? 0
  }

  // ── flatten nested joins and normalise into clean types ───────────────────
  const todayLessons: LiveLesson[] = (todayRes?.data ?? []).map((r) => ({
    id: r.id,
    scheduled_at: r.scheduled_at,
    duration_minutes: r.duration_minutes,
    status: r.status,
    teacher_name: flatRel(r.teacher as any)?.full_name ?? 'Unknown',
    student_name: flatRel(r.student as any)?.full_name ?? 'Unknown',
  }))

  // Helper to normalise a raw report row from either pending or flagged query
  const mapReport = (r: any): PendingReportItem => {
    const lesson = flatRel(r.lesson as any)
    const student = flatRel(lesson?.student as any)
    return {
      id: r.id,
      status: r.status,
      deadline_at: r.deadline_at,
      lesson_scheduled_at: lesson?.scheduled_at ?? '',
      lesson_duration: lesson?.duration_minutes ?? 0,
      teacher_name: flatRel(r.teacher as any)?.full_name ?? 'Unknown',
      student_name: student?.full_name ?? 'Unknown',
    }
  }

  // Flagged reports first (shown in red), then pending ordered by deadline
  const pendingAndFlagged: PendingReportItem[] = [
    ...(flaggedRes.data ?? []).map(mapReport),
    ...(pendingRes.data ?? []).map(mapReport),
  ]

  const missingTeamsLessons: AlertLesson[] = (missingTeamsRes.data ?? []).map((r) => ({
    id: r.id,
    scheduled_at: r.scheduled_at,
    duration_minutes: r.duration_minutes,
    teacher_name: flatRel(r.teacher as any)?.full_name ?? 'Unknown',
    student_name: flatRel(r.student as any)?.full_name ?? 'Unknown',
  }))

  // Classes Today stat excludes cancelled lessons. Null when the timezone is unset: we cannot
  // honestly bucket "today" without the admin's zone, so the card prompts them to set it.
  const stats: DashboardStats = {
    classesTodayCount: timezoneMissing
      ? null
      : todayLessons.filter((l) => !isCancelledStatus(l.status)).length,
    pendingCount: pendingRes.data?.length ?? 0,
    flaggedCount: flaggedCountRes.count ?? 0,
    lowHoursCount,
    invoicesToReviewCount: invoicesRes.count ?? 0,
    activeAnnouncementsCount: announcementsRes.data?.length ?? 0,
  }

  return (
    <DashboardClient
      stats={stats}
      todayLessons={todayLessons}
      pendingAndFlagged={pendingAndFlagged}
      activeAnnouncementText={announcementsRes.data?.[0]?.message ?? null}
      missingTeamsLessons={missingTeamsLessons}
      zeroBalanceWithClassesCount={zeroBalanceWithClassesCount}
      todayLabel={buildLabelInTz(new Date(), adminTimezone)}
      adminTimezone={adminTimezone}
      timezoneMissing={timezoneMissing}
      hasError={hasError}
    />
  )
}
