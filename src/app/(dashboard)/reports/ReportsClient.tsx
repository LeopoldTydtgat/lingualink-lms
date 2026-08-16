'use client'

import { useState } from 'react'
import Link from 'next/link'
import { reopenReport } from './actions'

// --- Types ---

type Student = {
  id: string
  full_name: string
  photo_url: string | null
}

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  student: Student
}

type Report = {
  id: string
  status: 'pending' | 'completed' | 'flagged' | 'reopened'
  did_class_happen: boolean | null
  no_show_type: string | null
  feedback_text: string | null
  deadline_at: string | null
  completed_at: string | null
  flagged_at: string | null
  created_at: string
  lesson: Lesson
}

type Props = {
  reports: Report[]
  profile: { id: string; full_name: string; role: string }
  isAdmin: boolean
  // The signed-in viewer's own IANA timezone, from their profiles row. The server
  // page gates on it, so it is never null and never a 'UTC' stand-in.
  viewerTimezone: string
}

// --- Helper: class date/time in the viewer's timezone ---
// Times are stored in UTC. Each is formatted in the viewer's own zone via Intl with
// an EXPLICIT timeZone, mirroring (admin)/admin/reports/ReportsClient.tsx. That is
// deterministic — the same output on the server and in the browser — so it is safe
// in this client component under SSR. The date-fns format(new Date(x), ...) it
// replaces carried no zone: the server rendered in the host's zone and the browser
// re-rendered in the viewer's, which both mismatched on hydration and showed the
// wrong wall-clock time to any teacher whose browser zone differs from their profile.
// Two formatters joined by the same ' · ' the old pattern used: one combined
// formatter would replace that separator with a comma of its own.
function formatClassDateTime(iso: string, timezone: string): string {
  const instant = new Date(iso)
  const datePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(instant)
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(instant)
  return `${datePart} · ${timePart}`
}

export default function ReportsClient({ reports, profile, isAdmin, viewerTimezone }: Props) {
  const [search, setSearch] = useState('')
  const [showAllCompleted, setShowAllCompleted] = useState(false)

  // Capture a single "now" so every pending check compares against the same instant
  const now = Date.now()

  const pendingReports = reports.filter(
    r =>
      (r.status === 'pending' || r.status === 'reopened') &&
      hasClassStarted(r, now)
  )

  // Submitted and not-submitted reports share one list, newest class first.
  // .filter() returns a fresh array, so the .sort() never mutates the prop.
  const completedReports = reports
    .filter(r => r.status === 'completed' || r.status === 'flagged')
    .sort((a, b) => reportSortKey(b) - reportSortKey(a))

  const filteredCompleted = completedReports.filter(r =>
    r.lesson?.student?.full_name
      .toLowerCase()
      .includes(search.toLowerCase())
  )

  const isSearching = search.trim().length > 0
  const displayCompleted = (showAllCompleted || isSearching)
    ? filteredCompleted
    : filteredCompleted.slice(0, 10)

  return (
    <div className="space-y-6">

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Class Reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            Complete a report within 12 hours of each class ending.
          </p>
        </div>
        <input
          type="text"
          placeholder="Search completed by student..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </div>

      {/* Pending reports */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-semibold text-gray-800">Pending Reports</span>
          {pendingReports.length > 0 && (
            <span style={{ fontSize: '12px', fontWeight: 600, borderRadius: '9999px', padding: '2px 10px', backgroundColor: '#FFF8E8', color: '#B45309' }}>
              {pendingReports.length}
            </span>
          )}
        </div>

        {pendingReports.length === 0 ? (
          <p className="text-sm text-gray-500">No pending reports. You are all caught up.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {pendingReports.map(report => (
              <PendingReportCard key={report.id} report={report} isAdmin={isAdmin} viewerTimezone={viewerTimezone} />
            ))}
          </div>
        )}
      </section>

      {/* Completed reports */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-semibold text-gray-800">Completed Reports</span>
          <span style={{ fontSize: '12px', fontWeight: 600, borderRadius: '9999px', padding: '2px 10px', backgroundColor: '#f3f4f6', color: '#6b7280' }}>
            {filteredCompleted.length}
          </span>
        </div>

        {filteredCompleted.length === 0 ? (
          <p className="text-sm text-gray-500">No completed reports yet.</p>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {displayCompleted.map(report => (
                <CompletedReportCard key={report.id} report={report} isAdmin={isAdmin} viewerTimezone={viewerTimezone} />
              ))}
            </div>
            {!showAllCompleted && !isSearching && filteredCompleted.length > 10 && (
              <div className="flex justify-center">
                <button
                  onClick={() => setShowAllCompleted(true)}
                  style={{ color: '#FF8303' }}
                  className="text-sm font-medium py-2 cursor-pointer"
                >
                  Show all ({filteredCompleted.length})
                </button>
              </div>
            )}
          </>
        )}
      </section>

    </div>
  )
}

// --- Pending report card ---
function PendingReportCard({
  report,
  isAdmin,
  viewerTimezone,
}: {
  report: Report
  isAdmin: boolean
  viewerTimezone: string
}) {
  const lesson = report.lesson
  const student = lesson?.student
  const deadlineLabel = report.deadline_at
    ? getDeadlineLabel(report.deadline_at)
    : null
  const deadlineMs = report.deadline_at
    ? new Date(report.deadline_at).getTime() - Date.now()
    : null

  let deadlineStyle: React.CSSProperties
  if (deadlineLabel === 'Overdue') {
    deadlineStyle = { backgroundColor: '#FFEEE6', color: '#FD5602', fontWeight: 700 }
  } else if (deadlineMs !== null && deadlineMs <= 3 * 60 * 60 * 1000) {
    deadlineStyle = { color: '#FD5602', fontWeight: 700 }
  } else {
    deadlineStyle = { color: '#B45309', fontWeight: 500 }
  }
  const isOverdue = deadlineLabel === 'Overdue'

  return (
    <div
      className="rounded-xl p-4 flex items-center justify-between shadow-sm"
      style={{ backgroundColor: '#FFFDF5', border: '1px solid #f3f4f6', borderLeft: '3px solid #FFB942' }}
    >
      <div className="flex items-center gap-4">
        {student?.photo_url ? (
          <img
            src={student.photo_url}
            alt={student.full_name}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-sm">
            {student?.full_name?.charAt(0) ?? '?'}
          </div>
        )}
        <div>
          <p className="font-semibold text-gray-900">
            {student?.full_name ?? 'Unknown student'}
          </p>
          <p className="text-sm text-gray-500">
            {lesson?.scheduled_at
              ? formatClassDateTime(lesson.scheduled_at, viewerTimezone)
              : 'Unknown time'}
          </p>
          {report.status === 'reopened' && (
            <span className="text-xs text-orange-600 font-medium">
              Reopened by admin
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {deadlineLabel && (
          isOverdue ? (
            <span
              className="text-xs"
              style={{ ...deadlineStyle, borderRadius: '9999px', padding: '2px 10px' }}
            >
              Overdue
            </span>
          ) : (
            <span className="text-xs" style={deadlineStyle}>{deadlineLabel}</span>
          )
        )}
        <Link
          href={`/reports/${report.id}`}
          prefetch={false}
          style={{ backgroundColor: '#FF8303' }}
          className="text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors btn-primary-hover"
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
        >
          Complete Report
        </Link>
      </div>
    </div>
  )
}

// --- Completed report card ---
function CompletedReportCard({
  report,
  isAdmin,
  viewerTimezone,
}: {
  report: Report
  isAdmin: boolean
  viewerTimezone: string
}) {
  const lesson = report.lesson
  const student = lesson?.student
  const [reopening, setReopening] = useState(false)
  const [reopenError, setReopenError] = useState<string | null>(null)

  const statusConfig: Record<string, { label: string; bg: string; fg: string }> = {
    completed: { label: 'Class taken', bg: '#DCFCE7', fg: '#15803D' },
    flagged: { label: 'Report not submitted', bg: '#FFF8E8', fg: '#B45309' },
    reopened: { label: 'Reopened', bg: '#FFF0E0', fg: '#C2410C' },
    pending: { label: 'Pending', bg: '#FFF8E8', fg: '#B45309' },
  }

  const { label, bg, fg } =
    report.status === 'completed' && report.did_class_happen === false
      ? report.no_show_type === 'teacher'
        ? { label: 'Teacher absent', bg: '#FFEEE6', fg: '#FD5602' }
        : { label: 'Student absent', bg: '#FFF0E0', fg: '#C2410C' }
      : statusConfig[report.status] ?? statusConfig.completed

  // Admin-only recovery path: a report that was never submitted ('flagged') and a
  // submitted-but-wrong one ('completed') that needs correcting and re-filing.
  const canReopen = isAdmin && (report.status === 'flagged' || report.status === 'completed')

  // Call the server action to reopen the report
  async function handleReopen() {
    setReopening(true)
    setReopenError(null)
    // reopenReport returns its errors rather than throwing, but the call can still
    // reject: createClient() runs above every guarded branch in the action, so a
    // cookie-store failure throws server-side, and a network fault or a stale
    // deployment id fails the action request itself. Without this catch the
    // rejection left `reopening` true forever, wedging the button at "Reopening..."
    // with no message. No finally on purpose: on success the row's status becomes
    // 'reopened', canReopen goes false and the button unmounts, so clearing the
    // flag on the success path would only re-enable it for the frame before the
    // revalidated props commit and admit a second click that the action then
    // refuses.
    try {
      const result = await reopenReport(report.id)
      if (result.error) {
        setReopenError(result.error)
        setReopening(false)
      }
    } catch {
      setReopenError('Could not reach the server. The report was NOT reopened - please try again.')
      setReopening(false)
    }
    // On success, revalidatePath in the action refreshes the page automatically
  }

  return (
    <div
      className="bg-white rounded-xl p-4 flex items-center justify-between shadow-sm"
      style={{ border: '1px solid #f3f4f6' }}
    >
      <div className="flex items-center gap-4">
        {student?.photo_url ? (
          <img
            src={student.photo_url}
            alt={student.full_name}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 font-bold text-sm">
            {student?.full_name?.charAt(0) ?? '?'}
          </div>
        )}
        <div>
          <p className="font-semibold text-gray-900">
            {student?.full_name ?? 'Unknown student'}
          </p>
          <p className="text-sm text-gray-500">
            {lesson?.scheduled_at
              ? formatClassDateTime(lesson.scheduled_at, viewerTimezone)
              : 'Unknown time'}
          </p>
          {reopenError && (
            <p className="text-xs text-red-500 mt-1">{reopenError}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span
          className="text-xs font-semibold px-2.5 py-0.5 rounded-full"
          style={{ backgroundColor: bg, color: fg }}
        >
          {label}
        </span>
        <Link
          href={`/reports/${report.id}`}
          prefetch={false}
          className="text-sm"
          style={{ color: '#FF8303', fontWeight: 500 }}
        >
          View
        </Link>
        {canReopen && (
          <button
            onClick={handleReopen}
            disabled={reopening}
            className="text-sm text-orange-600 hover:text-orange-700 font-medium disabled:opacity-50"
          >
            {reopening ? 'Reopening...' : 'Reopen'}
          </button>
        )}
      </div>
    </div>
  )
}

// --- Helper: sort key for the completed list ---
// scheduled_at is the natural ordering key. A report whose lesson row is
// missing (page.tsx flattens an absent join to null) falls back to its own
// created_at, so it still sorts sensibly instead of crashing or sinking to
// the epoch. An unparseable value sorts last rather than poisoning the sort
// with NaN.
function reportSortKey(report: Report): number {
  const raw = report.lesson?.scheduled_at ?? report.created_at
  const ms = raw ? new Date(raw).getTime() : NaN
  return Number.isNaN(ms) ? 0 : ms
}

// --- Helper: has the lesson's class already started? ---
// A pending report only surfaces once the class has begun (scheduled_at <= now).
// No scheduled_at means the class cannot have started yet, so exclude it.
function hasClassStarted(report: Report, now: number): boolean {
  const scheduledAt = report.lesson?.scheduled_at
  if (!scheduledAt) return false
  return new Date(scheduledAt).getTime() <= now
}

// --- Helper: deadline countdown label ---
function getDeadlineLabel(deadlineAt: string): string {
  const now = new Date()
  const deadline = new Date(deadlineAt)
  const diffMs = deadline.getTime() - now.getTime()

  if (diffMs <= 0) return 'Overdue'

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))

  if (diffHours > 0) return `${diffHours}h ${diffMins}m remaining`
  return `${diffMins}m remaining`
}
