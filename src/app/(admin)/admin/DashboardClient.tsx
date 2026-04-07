'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  CalendarDays,
  FileText,
  AlertTriangle,
  Users,
  CreditCard,
  Megaphone,
  RefreshCw,
} from 'lucide-react'
import type {
  DashboardStats,
  LiveLesson,
  PendingReportItem,
  AlertLesson,
} from './page'

interface Props {
  stats: DashboardStats
  todayLessons: LiveLesson[]
  pendingAndFlagged: PendingReportItem[]
  activeAnnouncementText: string | null
  missingTeamsLessons: AlertLesson[]
  zeroBalanceWithClassesCount: number
  todayLabel: string // pre-computed server-side as SAST date string
}

// ── time formatting ───────────────────────────────────────────────────────────
// Times are stored in UTC. Shannon is always in SAST (UTC+2), so we add 2h.
// These functions are deterministic — safe in client components with SSR.

function toSAST(isoStr: string): Date {
  return new Date(new Date(isoStr).getTime() + 2 * 60 * 60 * 1000)
}

function fmtTime(isoStr: string): string {
  if (!isoStr) return '—'
  const d = toSAST(isoStr)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function fmtDate(isoStr: string): string {
  if (!isoStr) return '—'
  const d = toSAST(isoStr)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

// ── lesson status helpers ─────────────────────────────────────────────────────

function getEffectiveStatus(lesson: LiveLesson): string {
  if (lesson.status === 'cancelled') return 'Cancelled'
  if (lesson.status === 'completed') return 'Completed'
  if (lesson.status === 'student_no_show' || lesson.status === 'teacher_no_show') return 'No-Show'
  const start = new Date(lesson.scheduled_at).getTime()
  const end = start + lesson.duration_minutes * 60 * 1000
  const now = Date.now()
  if (now >= start && now < end) return 'In Progress'
  if (now >= end) return 'Completed'
  return 'Upcoming'
}

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  Upcoming:     { bg: '#dbeafe', color: '#1e40af' },
  'In Progress':{ bg: '#dcfce7', color: '#166534' },
  Completed:    { bg: '#f3f4f6', color: '#374151' },
  'No-Show':    { bg: '#fef3c7', color: '#92400e' },
  Cancelled:    { bg: '#fee2e2', color: '#991b1b' },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { bg: '#f3f4f6', color: '#6b7280' }
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ backgroundColor: s.bg, color: s.color }}
    >
      {status}
    </span>
  )
}

// ── overdue calculation ───────────────────────────────────────────────────────

function hoursOverdue(report: PendingReportItem): number {
  if (!report.lesson_scheduled_at) return 0
  const classEnd =
    new Date(report.lesson_scheduled_at).getTime() +
    report.lesson_duration * 60 * 1000
  return Math.max(0, (Date.now() - classEnd) / (1000 * 60 * 60))
}

// ── component ─────────────────────────────────────────────────────────────────

export default function DashboardClient({
  stats,
  todayLessons,
  pendingAndFlagged,
  activeAnnouncementText,
  missingTeamsLessons,
  zeroBalanceWithClassesCount,
  todayLabel,
}: Props) {
  const router = useRouter()

  // Auto-refresh server data every 30 seconds by re-running server components
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 30_000)
    return () => clearInterval(id)
  }, [router])

  const alertCount =
    missingTeamsLessons.length + (zeroBalanceWithClassesCount > 0 ? 1 : 0)

  // ── stat card definitions ─────────────────────────────────────────────────
  const statCards = [
    {
      label: 'Classes Today',
      value: stats.classesTodayCount,
      icon: CalendarDays,
      href: '/admin/classes',
      alert: false,
    },
    {
      label: 'Pending Reports',
      value: stats.pendingCount,
      icon: FileText,
      href: '/admin/reports?filter=pending',
      alert: false,
    },
    {
      label: 'Flagged Reports',
      value: stats.flaggedCount,
      icon: AlertTriangle,
      href: '/admin/reports?filter=flagged',
      alert: stats.flaggedCount > 0,
    },
    {
      label: 'Low Hours Students',
      value: stats.lowHoursCount,
      icon: Users,
      href: '/admin/students?filter=low_hours',
      alert: false,
    },
    {
      label: 'Invoices to Review',
      value: stats.invoicesToReviewCount,
      icon: CreditCard,
      href: '/admin/billing',
      alert: false,
    },
    {
      label: 'Active Announcements',
      value: stats.activeAnnouncementsCount,
      icon: Megaphone,
      href: '/admin/announcements',
      alert: false,
    },
  ]

  return (
    <div className="space-y-6">

      {/* ── page header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Refreshes every 30 seconds
          </p>
        </div>
        <button
          onClick={() => router.refresh()}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh now
        </button>
      </div>

      {/* ── active announcement banner ───────────────────────────────────── */}
      {activeAnnouncementText && (
        <div
          className="rounded-lg px-4 py-3 text-sm text-white flex items-start gap-2"
          style={{ backgroundColor: '#FF8303' }}
        >
          <Megaphone size={15} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">Active announcement: </span>
            {activeAnnouncementText}
          </span>
        </div>
      )}

      {/* ── stat cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon
          return (
            <Link key={card.label} href={card.href}>
              <div className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-500 leading-snug">{card.label}</p>
                  <Icon size={14} style={{ color: '#d1d5db' }} />
                </div>
                <p
                  className="text-3xl font-bold"
                  style={{ color: card.alert ? '#dc2626' : '#111827' }}
                >
                  {card.value}
                </p>
              </div>
            </Link>
          )
        })}
      </div>

      {/* ── live feed + pending reports ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Left: live classes feed */}
        <div className="lg:col-span-3 bg-white rounded-xl border border-gray-200 flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800 text-sm">Today&apos;s Classes</h2>
            <span className="text-xs text-gray-400">{todayLabel} · SAST</span>
          </div>

          {todayLessons.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-12 text-sm text-gray-400">
              No classes scheduled today.
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {todayLessons.map((lesson) => {
                const status = getEffectiveStatus(lesson)
                return (
                  <div
                    key={lesson.id}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/admin/classes/${lesson.id}`)}
                  >
                    {/* Time */}
                    <span className="text-xs text-gray-500 w-10 shrink-0 font-mono tabular-nums">
                      {fmtTime(lesson.scheduled_at)}
                    </span>

                    {/* Names + duration */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {lesson.teacher_name}
                        <span className="text-gray-400 font-normal">
                          {' · '}{lesson.student_name}
                        </span>
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {lesson.duration_minutes} min
                      </p>
                    </div>

                    <StatusBadge status={status} />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Right: pending + flagged reports */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800 text-sm">
              Pending Reports
            </h2>
            <Link
              href="/admin/reports?filter=pending"
              className="text-xs hover:underline"
              style={{ color: '#FF8303' }}
            >
              View all
            </Link>
          </div>

          {pendingAndFlagged.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-12 text-sm text-gray-400">
              All reports submitted ✓
            </div>
          ) : (
            <div className="divide-y divide-gray-50 overflow-y-auto max-h-80">
              {pendingAndFlagged.map((report) => {
                const isFlagged = report.status === 'flagged'
                const overdue = hoursOverdue(report)
                return (
                  <div
                    key={report.id}
                    className="px-5 py-3"
                    style={isFlagged ? { backgroundColor: '#fff5f5' } : {}}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {report.teacher_name}
                          <span className="text-gray-400 font-normal">
                            {' · '}{report.student_name}
                          </span>
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {fmtDate(report.lesson_scheduled_at)}{' '}
                          {fmtTime(report.lesson_scheduled_at)}
                          {' · '}{report.lesson_duration} min
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {isFlagged ? (
                          <>
                            <span
                              className="text-xs font-semibold"
                              style={{ color: '#dc2626' }}
                            >
                              Flagged
                            </span>
                            {/* Reopen will be wired to a server action in Step 8 */}
                            <div className="mt-1">
                              <Link
                                href={`/admin/reports?reopen=${report.id}`}
                                className="text-xs hover:underline"
                                style={{ color: '#FF8303' }}
                              >
                                Reopen
                              </Link>
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-gray-500">
                            {overdue >= 1
                              ? `${Math.floor(overdue)}h overdue`
                              : 'Due soon'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── alerts panel ─────────────────────────────────────────────────── */}
      {alertCount > 0 ? (
        <div className="bg-white rounded-xl border border-orange-200">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-orange-100">
            <AlertTriangle size={15} style={{ color: '#FF8303' }} />
            <h2 className="font-semibold text-gray-800 text-sm">
              Alerts
            </h2>
            <span
              className="ml-1 text-xs font-bold px-1.5 py-0.5 rounded-full text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              {alertCount}
            </span>
          </div>

          <div className="p-5 space-y-5">
            {/* Zero-balance students with upcoming classes */}
            {zeroBalanceWithClassesCount > 0 && (
              <div className="flex items-start gap-3">
                <div
                  className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: '#dc2626' }}
                />
                <div>
                  <p className="text-sm font-medium text-gray-800">
                    {zeroBalanceWithClassesCount}{' '}
                    {zeroBalanceWithClassesCount === 1 ? 'student has' : 'students have'}{' '}
                    zero hours remaining but{' '}
                    {zeroBalanceWithClassesCount === 1 ? 'has' : 'have'} upcoming classes booked
                  </p>
                  <Link
                    href="/admin/students?filter=zero_balance"
                    className="text-xs hover:underline mt-0.5 inline-block"
                    style={{ color: '#FF8303' }}
                  >
                    Review students →
                  </Link>
                </div>
              </div>
            )}

            {/* Classes in next 24h missing Teams link */}
            {missingTeamsLessons.length > 0 && (
              <div>
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: '#f59e0b' }}
                  />
                  <p className="text-sm font-medium text-gray-800">
                    {missingTeamsLessons.length}{' '}
                    {missingTeamsLessons.length === 1
                      ? 'class in the next 24 hours is'
                      : 'classes in the next 24 hours are'}{' '}
                    missing a Teams link
                  </p>
                </div>
                <div className="ml-5 space-y-2">
                  {missingTeamsLessons.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between text-xs text-gray-600"
                    >
                      <span>
                        {l.teacher_name}
                        <span className="text-gray-400"> · {l.student_name}</span>
                      </span>
                      <span className="text-gray-400 tabular-nums">
                        {fmtDate(l.scheduled_at)} {fmtTime(l.scheduled_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* No alerts */
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 flex items-center gap-3">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: '#22c55e' }}
          />
          <p className="text-sm text-gray-600">No alerts — everything looks good.</p>
        </div>
      )}
    </div>
  )
}
