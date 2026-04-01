'use client'

import { useState } from 'react'
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

  const pendingReports = reports.filter(
    r => r.status === 'pending' || r.status === 'reopened'
  )

  const completedReports = reports.filter(
    r => r.status === 'completed' || r.status === 'flagged'
  )

  const filteredCompleted = completedReports.filter(r =>
    r.lesson?.student?.full_name
      .toLowerCase()
      .includes(search.toLowerCase())
  )

  return (
    <div className="p-6 max-w-5xl mx-auto">

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Class Reports</h1>
        <p className="text-sm text-gray-500 mt-1">
          Complete a report within 12 hours of each class ending.
        </p>
      </div>

      {/* Pending reports */}
      <section className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Pending Reports</h2>
          {pendingReports.length > 0 && (
            <span className="bg-yellow-100 text-yellow-800 text-xs font-semibold px-2.5 py-0.5 rounded-full">
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

      {/* Completed reports */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Completed Reports</h2>
          <input
            type="text"
            placeholder="Search by student name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>

        {filteredCompleted.length === 0 ? (
          <p className="text-sm text-gray-500">No completed reports yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredCompleted.map(report => (
              <CompletedReportCard key={report.id} report={report} isAdmin={isAdmin} />
            ))}
          </div>
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

  return (
    <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex items-center justify-between">
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
          <span className="text-xs text-yellow-700 font-medium">{deadlineLabel}</span>
        )}
        <a
          href={`/reports/${report.id}`}
          style={{ backgroundColor: '#FF8303' }}
          className="text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Complete Report
        </a>
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
  const [reopening, setReopening] = useState(false)
  const [reopenError, setReopenError] = useState<string | null>(null)

  const statusConfig: Record<string, { label: string; colour: string }> = {
    completed: { label: 'Class taken', colour: 'bg-green-100 text-green-700' },
    flagged: { label: 'Flagged — no report', colour: 'bg-red-100 text-red-700' },
    reopened: { label: 'Reopened', colour: 'bg-orange-100 text-orange-700' },
    pending: { label: 'Pending', colour: 'bg-yellow-100 text-yellow-700' },
  }

  const { label, colour } = statusConfig[report.status] ?? statusConfig.completed

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
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between">
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
          {reopenError && (
            <p className="text-xs text-red-500 mt-1">{reopenError}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${colour}`}>
          {label}
        </span>
        <a
          href={`/reports/${report.id}`}
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          View
        </a>
        {/* Reopen button — admin only, flagged reports only */}
        {isAdmin && report.status === 'flagged' && (
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
