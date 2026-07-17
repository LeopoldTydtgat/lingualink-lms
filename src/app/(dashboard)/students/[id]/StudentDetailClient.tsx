'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { isCancelledStatus } from '@/lib/billing/billability'

type Student = {
  id: string
  full_name: string
  photo_url: string | null
  self_assessed_level: string | null
  timezone: string | null
  learning_goals: string | null
  interests: string | null
  language_preference: string | null
  teacher_notes: string | null
}

type Training = {
  id: string
  status: string
  total_hours: number
  hours_consumed: number
  start_date: string
  end_date: string | null
  package_type: string | null
  notes: string | null
  teacher_id: string
  students: Student | null
  profiles: { id: string; full_name: string } | null
}

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  teams_join_url: string | null
  teacher_id: string
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  profiles: { full_name: string } | null
}

type Report = {
  id: string
  lesson_id: string
  did_class_happen: boolean
  no_show_type: string | null
  feedback_text: string | null
  level_data: Record<string, string> | null
  status: string
  completed_at: string | null
}

type Assignment = {
  id: string
  assigned_at: string
  completed: boolean
  study_sheet: {
    title: string
    category: string | null
    level: string | null
  }
}

type Props = {
  training: Training
  upcomingLessons: Lesson[]
  pastLessons: Lesson[]
  reports: Report[]
  isAdmin: boolean
  currentUserId: string
  assignments: Assignment[]
  assignedTeacherNames: string[]
}

const TABS = ['General Info', 'Next Classes', 'Past Classes', 'Messages']

// Label for a NON-cancelled lesson status. Cancelled-family rows are handled
// separately via getCancellationLabel; this never receives them.
function nonCancelledStatusLabel(status: string): string {
  switch (status) {
    case 'scheduled': return 'Scheduled'
    case 'completed': return 'Completed'
    case 'student_no_show': return 'Student absent'
    case 'teacher_no_show': return 'Teacher absent'
    case 'missed': return 'Missed'
    default: {
      const spaced = status.replace(/_/g, ' ')
      return spaced.charAt(0).toUpperCase() + spaced.slice(1)
    }
  }
}

export default function StudentDetailClient({
  training,
  upcomingLessons,
  pastLessons,
  reports,
  assignments,
  assignedTeacherNames,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState('General Info')
  const student = training.students
  const [notes, setNotes] = useState(student?.teacher_notes ?? '')
  const [savedNotes, setSavedNotes] = useState(student?.teacher_notes ?? '')
  const [editingNotes, setEditingNotes] = useState(false)
  const [isSavingNotes, setIsSavingNotes] = useState(false)
  const [notesError, setNotesError] = useState('')

  async function handleSaveNotes() {
    if (!student) return
    setNotesError('')
    setIsSavingNotes(true)
    try {
      const res = await fetch(`/api/teacher/students/${student.id}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      })
      if (!res.ok) {
        setNotesError('Could not save notes. Please try again.')
        return
      }
      const data = await res.json()
      setSavedNotes(data.teacher_notes ?? notes)
      setEditingNotes(false)
    } finally {
      setIsSavingNotes(false)
    }
  }

  function getInitials(name: string) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  }

  function formatDateTime(dateStr: string) {
    return new Date(dateStr).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const hoursRemaining = training.total_hours - training.hours_consumed
  const progressPercent = training.total_hours > 0
    ? Math.round((training.hours_consumed / training.total_hours) * 100)
    : 0

  const reportsByLessonId = Object.fromEntries(
    reports.map(r => [r.lesson_id, r])
  )

  // ── TAB: General Info ──────────────────────────────────────────
  function GeneralInfoTab() {
    return (
      <div className="space-y-6">

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div className="bg-white rounded-xl shadow-sm p-4 text-center" style={{ border: '1px solid #f3f4f6' }}>
            <p className="text-2xl font-bold text-gray-900">{training.total_hours}h</p>
            <p className="text-xs text-gray-500 mt-1">Total Hours</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 text-center" style={{ border: '1px solid #f3f4f6' }}>
            <p className="text-2xl font-bold text-gray-900">{training.hours_consumed}h</p>
            <p className="text-xs text-gray-500 mt-1">Hours Used</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 text-center" style={{ border: '1px solid #f3f4f6' }}>
            <p className="text-2xl font-bold" style={{ color: '#FF8303' }}>{hoursRemaining}h</p>
            <p className="text-xs text-gray-500 mt-1">Remaining</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>Training Progress</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className="h-2 rounded-full transition-all"
              style={{ width: `${progressPercent}%`, backgroundColor: '#FF8303' }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>Started {formatDate(training.start_date)}</span>
            <span>Ends {formatDate(training.end_date)}</span>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3" style={{ border: '1px solid #f3f4f6' }}>
          <h3 className="font-semibold text-gray-900">Training Details</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-gray-500">Package</p>
              <p className="font-medium text-gray-900">{training.package_type ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Status</p>
              <p className="font-medium capitalize text-gray-900">{training.status}</p>
            </div>
            <div>
              <p className="text-gray-500">Assigned Teachers</p>
              <p className="font-medium text-gray-900">{assignedTeacherNames.length ? assignedTeacherNames.join(', ') : '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Student Level (self-assessed)</p>
              <p className="font-medium text-gray-900">{student?.self_assessed_level ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Timezone</p>
              <p className="font-medium text-gray-900">{student?.timezone ?? '—'}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3" style={{ border: '1px solid #f3f4f6' }}>
          <h3 className="font-semibold text-gray-900">Learning Profile</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-gray-500">Learning Goals</p>
              <p className="font-medium text-gray-900">{student?.learning_goals ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Interests</p>
              <p className="font-medium text-gray-900">{student?.interests ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Language Preference</p>
              <p className="font-medium text-gray-900">{student?.language_preference ?? '—'}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-900">Notes</h3>
            {!editingNotes && (
              <button
                onClick={() => setEditingNotes(true)}
                className="text-xs px-3 py-1 rounded border border-gray-300 hover:border-gray-400 text-gray-600"
              >
                Edit
              </button>
            )}
          </div>
          {editingNotes ? (
            <div className="space-y-2">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={4}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 resize-none"
                style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
                placeholder="Add notes about this student (not visible to the student)..."
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveNotes}
                  disabled={isSavingNotes}
                  className="text-xs px-3 py-1 rounded text-white"
                  style={{ backgroundColor: '#FF8303', cursor: isSavingNotes ? 'wait' : 'pointer', opacity: isSavingNotes ? 0.7 : 1 }}
                >
                  {isSavingNotes ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setNotes(savedNotes)
                    setNotesError('')
                    setEditingNotes(false)
                  }}
                  disabled={isSavingNotes}
                  className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600"
                >
                  Cancel
                </button>
                {notesError && (
                  <p className="text-xs" style={{ color: '#FD5602' }}>{notesError}</p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-600 whitespace-pre-wrap">
              {notes || <span className="text-gray-400 italic">No notes yet.</span>}
            </p>
          )}
        </div>

        {/* ── Assigned Study Sheets (read-only) ── */}
        {assignments.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Assigned Study Sheets
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{assignments.length}</span>
            </h3>
            <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f3f4f6' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Sheet</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Category</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Level</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Date Assigned</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-4 py-3 font-medium text-gray-900">{a.study_sheet.title}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{a.study_sheet.category ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{a.study_sheet.level ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-500">
                        {new Date(a.assigned_at).toLocaleDateString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs px-2 py-1 rounded-full${a.completed ? '' : ' bg-gray-100 text-gray-500'}`}
                          style={a.completed ? { backgroundColor: '#DCFCE7', color: '#15803D' } : undefined}
                        >
                          {a.completed ? 'Completed' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    )
  }

  // ── TAB: Next Classes ──────────────────────────────────────────
  function NextClassesTab() {
    if (upcomingLessons.length === 0) {
      return <p className="text-sm text-gray-400 text-center py-12">No upcoming classes scheduled.</p>
    }
    return (
      <div className="space-y-3">
        {upcomingLessons.map(lesson => (
          <div key={lesson.id} className="bg-white rounded-xl shadow-sm p-4 flex items-center justify-between" style={{ border: '1px solid #f3f4f6' }}>
            <div>
              <p className="font-medium text-gray-900">{formatDateTime(lesson.scheduled_at)}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {lesson.duration_minutes} min · {lesson.profiles?.full_name ?? 'Unknown teacher'}
              </p>
            </div>
            <div className="flex gap-2">
              <span
                className="text-xs px-2 py-1 rounded-full border"
                style={
                  lesson.status === 'scheduled'
                    ? { borderColor: '#FF8303', color: '#FF8303' }
                    : { borderColor: '#d1d5db', color: '#6b7280' }
                }
              >
                {isCancelledStatus(lesson.status)
                  ? getCancellationLabel(lesson, 'teacher') ?? 'Cancelled'
                  : nonCancelledStatusLabel(lesson.status)}
              </span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── TAB: Past Classes ──────────────────────────────────────────
  function PastClassesTab() {
    if (pastLessons.length === 0) {
      return <p className="text-sm text-gray-400 text-center py-12">No past classes yet.</p>
    }
    return (
      <div className="space-y-3">
        {[...pastLessons].reverse().map(lesson => {
          const report = reportsByLessonId[lesson.id]
          const cancelled = isCancelledStatus(lesson.status)
          return (
            <div key={lesson.id} className="bg-white rounded-xl shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-gray-900">{formatDateTime(lesson.scheduled_at)}</p>
                {cancelled ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500">
                    {getCancellationLabel(lesson, 'teacher') ?? 'Cancelled'}
                  </span>
                ) : report ? (
                  <span
                    className="text-xs px-2 py-1 rounded-full"
                    style={
                      report.did_class_happen
                        ? { backgroundColor: '#DCFCE7', color: '#15803D' }
                        : report.no_show_type === 'student'
                        ? { backgroundColor: '#FFF8E8', color: '#B45309' }
                        : { backgroundColor: '#FFEEE6', color: '#FD5602' }
                    }
                  >
                    {report.did_class_happen
                      ? 'Class taken'
                      : report.no_show_type === 'student'
                      ? 'Student absent'
                      : report.no_show_type === 'teacher'
                      ? 'Teacher absent'
                      : 'Class missed'}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500">
                    No report
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                By {lesson.profiles?.full_name ?? 'Unknown teacher'} · {lesson.duration_minutes} min
              </p>
              {cancelled && lesson.cancelled_at && (
                <p className="text-xs text-gray-500 mt-1">
                  Cancelled {formatDate(lesson.cancelled_at)}
                  {lesson.cancellation_reason ? ` · ${lesson.cancellation_reason}` : ''}
                </p>
              )}
              {!cancelled && report?.feedback_text && (
                <p className="text-sm text-gray-600 mt-2 line-clamp-2 italic">
                  &ldquo;{report.feedback_text}&rdquo;
                </p>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // ── TAB: Messages ─────────────────────────────────────────────
  function MessagesTab() {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6 flex flex-col items-center gap-4" style={{ border: '1px solid #f3f4f6' }}>
        <p className="text-sm text-gray-500">Send a direct message to this student via the Messages page.</p>
        <Link
          href={`/messages?studentId=${student!.id}`}
          prefetch={false}
          className="text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors"
          style={{ border: '2px solid #d1d5db', backgroundColor: 'white', color: '#374151', textDecoration: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#FF8303'; e.currentTarget.style.color = '#FF8303' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#374151' }}
        >
          Message {student!.full_name}
        </Link>
      </div>
    )
  }

  const tabCounts: Record<string, number | undefined> = { 'Next Classes': upcomingLessons.length, 'Past Classes': pastLessons.length }

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      <button
        onClick={() => router.push('/students')}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
        Back to Students
      </button>

      <div className="flex items-center gap-4">
        {student?.photo_url ? (
          <img
            src={student.photo_url}
            alt={student.full_name}
            className="w-16 h-16 rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
            style={{ backgroundColor: '#FF8303' }}
          >
            {student ? getInitials(student.full_name) : '?'}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{student?.full_name ?? 'Unknown Student'}</h1>
        </div>
      </div>

      {/* Manual tab bar — shadcn Tabs not used due to Tailwind v4 incompatibility */}
      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex items-center justify-center px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
            style={
              activeTab === tab
                ? { borderBottomColor: '#FF8303', color: '#FF8303', minWidth: '130px' }
                : { borderBottomColor: 'transparent', color: '#6b7280', minWidth: '130px' }
            }
          >
            {tab}
            {tabCounts[tab] !== undefined && (
              <span className="ml-1.5 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{tabCounts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Invoked as functions, not JSX: inner components get a new identity each render and would remount (textarea loses focus per keystroke) */}
      {activeTab === 'General Info' && GeneralInfoTab()}
      {activeTab === 'Next Classes' && NextClassesTab()}
      {activeTab === 'Past Classes' && PastClassesTab()}
      {activeTab === 'Messages' && MessagesTab()}

    </div>
  )
}
