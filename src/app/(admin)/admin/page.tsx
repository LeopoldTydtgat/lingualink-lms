import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import DashboardClient from './DashboardClient'

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

function getTodayUTCRange() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return { start: utcTimestamp(start), end: utcTimestamp(end) }
}

// Build a SAST (UTC+2) date label for display — computed server-side to avoid hydration mismatch
function buildSASTDateLabel(): string {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

// ── nested join flattener ─────────────────────────────────────────────────────
// Supabase can return joined relations as arrays or objects — always flatten safely.
function flatRel<T>(val: T | T[] | null | undefined): T | null {
  if (val == null) return null
  return Array.isArray(val) ? (val[0] ?? null) : val
}

// ── exported types (used by DashboardClient) ──────────────────────────────────
export interface DashboardStats {
  classesTodayCount: number
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
  status: 'pending' | 'flagged'
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

// ── page ──────────────────────────────────────────────────────────────────────
export default async function AdminDashboardPage() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )

  const { start: todayStart, end: todayEnd } = getTodayUTCRange()
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
    // Today's lessons (live classes feed)
    supabase
      .from('lessons')
      .select(`
        id, scheduled_at, duration_minutes, status,
        teacher:profiles!teacher_id(full_name),
        student:students!student_id(full_name)
      `)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', todayEnd)
      .order('scheduled_at'),

    // Pending reports with teacher + lesson + student (for the pending panel)
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
      .eq('status', 'pending')
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
      .neq('status', 'cancelled'),
  ])

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
      .neq('status', 'cancelled')
    zeroBalanceWithClassesCount = count ?? 0
  }

  // ── flatten nested joins and normalise into clean types ───────────────────
  const todayLessons: LiveLesson[] = (todayRes.data ?? []).map((r) => ({
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

  // Classes Today stat excludes cancelled lessons
  const stats: DashboardStats = {
    classesTodayCount: todayLessons.filter((l) => l.status !== 'cancelled').length,
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
      todayLabel={buildSASTDateLabel()}
    />
  )
}
