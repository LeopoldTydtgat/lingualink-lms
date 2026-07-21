'use client'

import { useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
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
  teacher: { id: string; full_name: string }
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
}

export default function ReportsClient({ reports, profile, isAdmin }: Props) {
  const [search, setSearch] = useState('')
  const [showAllCompleted, setShowAllCompleted] = useState(false)

  // Capture a single "now" so every pending check compares against the same instant
  const now = Date.now()

  const pendingReports = reports.filter(
    r =>
      (r.status === 'pending' || r.status === 'reopened') &&
      hasClassStarted(r, now)
  )

  const completedReports = reports.filter(
    r => r.status === 'completed'
  )

  const missedReports = reports.filter(
    r => r.status === 'flagged'
  )

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
              <PendingReportCard key={report.id} report={report} isAdmin={isAdmin} />
            ))}
          </div>
        )}
      </section>

      {/* Missed reports */}
      {missedReports.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="font-semibold text-gray-800">Missed Reports</span>
            <span style={{ fontSize: '12px', fontWeight: 600, borderRadius: '9999px', padding: '2px 10px', backgroundColor: '#FFEEE6', color: '#FD5602' }}>
              {missedReports.length}
            </span>
          </div>

          <div className="flex flex-col gap-3">
            {missedReports.map(report => (
              <MissedReportCard key={report.id} report={report} isAdmin={isAdmin} />
            ))}
          </div>
        </section>
      )}

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
                <CompletedReportCard key={report.id} report={report} isAdmin={isAdmin} />
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
}: {
  report: Report
  isAdmin: boolean
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
              ? format(new Date(lesson.scheduled_at), 'EEE d MMM yyyy · HH:mm')
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
}: {
  report: Report
  isAdmin: boolean
}) {
  const lesson = report.lesson
  const student = lesson?.student

  const statusConfig: Record<string, { label: string; bg: string; fg: string }> = {
    completed: { label: 'Class taken', bg: '#DCFCE7', fg: '#15803D' },
    flagged: { label: 'Flagged — no report', bg: '#FFEEE6', fg: '#FD5602' },
    reopened: { label: 'Reopened', bg: '#FFF0E0', fg: '#C2410C' },
    pending: { label: 'Pending', bg: '#FFF8E8', fg: '#B45309' },
  }

  const { label, bg, fg } = statusConfig[report.status] ?? statusConfig.completed

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
              ? format(new Date(lesson.scheduled_at), 'EEE d MMM yyyy · HH:mm')
              : 'Unknown time'}
          </p>
          {isAdmin && (
            <p className="text-xs text-gray-400">
              By {lesson?.teacher?.full_name ?? 'Unknown teacher'}
            </p>
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
      </div>
    </div>
  )
}

// --- Missed report card ---
function MissedReportCard({
  report,
  isAdmin,
}: {
  report: Report
  isAdmin: boolean
}) {
  const lesson = report.lesson
  const student = lesson?.student
  const [reopening, setReopening] = useState(false)
  const [reopenError, setReopenError] = useState<string | null>(null)

  // Call the server action to reopen the report
  async function handleReopen() {
    setReopening(true)
    setReopenError(null)
    const result = await reopenReport(report.id)
    if (result.error) {
      setReopenError(result.error)
      setReopening(false)
    }
    // On success, revalidatePath in the action refreshes the page automatically
  }

  return (
    <div
      className="rounded-xl p-4 flex items-center justify-between shadow-sm"
      style={{ backgroundColor: '#FFF8F5', border: '1px solid #f3f4f6', borderLeft: '3px solid #FD5602' }}
    >
      <div className="flex items-center gap-4">
        {student?.photo_url ? (
          <img
            src={student.photo_url}
            alt={student.full_name}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm"
            style={{ backgroundColor: 'rgba(220,38,38,0.12)', color: '#dc2626' }}
          >
            {student?.full_name?.charAt(0) ?? '?'}
          </div>
        )}
        <div>
          <p className="font-semibold text-gray-900">
            {student?.full_name ?? 'Unknown student'}
          </p>
          <p className="text-sm text-gray-500">
            {lesson?.scheduled_at
              ? format(new Date(lesson.scheduled_at), 'EEE d MMM yyyy · HH:mm')
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
          style={{ backgroundColor: '#FFEEE6', color: '#FD5602' }}
        >
          Missed — payment forfeited
        </span>
        <Link
          href={`/reports/${report.id}`}
          prefetch={false}
          className="text-sm"
          style={{ color: '#FF8303', fontWeight: 500 }}
        >
          View
        </Link>
        {isAdmin && (
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
