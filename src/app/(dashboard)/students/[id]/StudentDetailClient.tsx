'use client'

import Link from 'next/link'
import { useState } from 'react'

type Student = {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  self_reported_level: string | null
  timezone: string | null
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

type Props = {
  training: Training
  upcomingLessons: Lesson[]
  pastLessons: Lesson[]
  reports: Report[]
  isAdmin: boolean
  currentUserId: string
}

const TABS = ['General Info', 'Next Classes', 'Past Classes', 'Messages']

export default function StudentDetailClient({
  training,
  upcomingLessons,
  pastLessons,
  reports,
  isAdmin,
}: Props) {
  const [activeTab, setActiveTab] = useState('General Info')
  const [notes, setNotes] = useState(training.notes ?? '')
  const [editingNotes, setEditingNotes] = useState(false)

  const student = training.students

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

        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{training.total_hours}h</p>
            <p className="text-xs text-gray-500 mt-1">Total Hours</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{training.hours_consumed}h</p>
            <p className="text-xs text-gray-500 mt-1">Hours Used</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
            <p className="text-2xl font-bold" style={{ color: '#FF8303' }}>{hoursRemaining}h</p>
            <p className="text-xs text-gray-500 mt-1">Remaining</p>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
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

        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
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
              <p className="text-gray-500">Assigned Teacher</p>
              <p className="font-medium text-gray-900">{training.profiles?.full_name ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Student Level (self-reported)</p>
              <p className="font-medium text-gray-900">{student?.self_reported_level ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Timezone</p>
              <p className="font-medium text-gray-900">{student?.timezone ?? '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">Email</p>
              <p className="font-medium text-gray-900">{student?.email ?? '—'}</p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
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
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    // TODO: wire up save to Supabase in a later step
                    setEditingNotes(false)
                  }}
                  className="text-xs px-3 py-1 rounded text-white"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setNotes(training.notes ?? '')
                    setEditingNotes(false)
                  }}
                  className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-600 whitespace-pre-wrap">
              {notes || <span className="text-gray-400 italic">No notes yet.</span>}
            </p>
          )}
        </div>

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
          <div key={lesson.id} className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">{formatDateTime(lesson.scheduled_at)}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {lesson.duration_minutes} min · {lesson.profiles?.full_name ?? 'Unknown teacher'}
              </p>
            </div>
            <div className="flex gap-2">
              {lesson.teams_join_url && (
                <a
                  href={lesson.teams_join_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1 rounded text-white"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  Join
                </a>
              )}
              <span
                className="text-xs px-2 py-1 rounded-full border capitalize"
                style={
                  lesson.status === 'scheduled'
                    ? { borderColor: '#FF8303', color: '#FF8303' }
                    : { borderColor: '#d1d5db', color: '#6b7280' }
                }
              >
                {lesson.status}
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
          return (
            <div key={lesson.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-gray-900">{formatDateTime(lesson.scheduled_at)}</p>
                {report ? (
                  <span
                    className="text-xs px-2 py-1 rounded-full text-white"
                    style={{ backgroundColor: report.did_class_happen ? '#22c55e' : '#FD5602' }}
                  >
                    {report.did_class_happen ? 'Class taken' : report.no_show_type === 'student_no_show' ? 'Student absent' : 'Teacher absent'}
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
              {report?.feedback_text && (
                <p className="text-sm text-gray-600 mt-2 line-clamp-2 italic">
                  "{report.feedback_text}"
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
      <div className="bg-white border border-gray-200 rounded-lg p-6 flex flex-col items-center gap-4">
        <p className="text-sm text-gray-500">Send a direct message to this student via the Messages page.</p>
        <Link
          href={`/messages?studentId=${student!.id}`}
          prefetch={false}
          style={{
            padding: '10px 24px',
            backgroundColor: '#FF8303',
            color: '#ffffff',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: '600',
            textDecoration: 'none',
          }}
        >
          Message {student!.full_name}
        </Link>
      </div>
    )
  }

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-4xl">

      <div className="flex items-center gap-4 mb-6">
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
          <p className="text-sm text-gray-500">{student?.email}</p>
        </div>
      </div>

      {/* Manual tab bar — shadcn Tabs not used due to Tailwind v4 incompatibility */}
      <div className="flex border-b border-gray-200 mb-6">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
            style={
              activeTab === tab
                ? { borderBottomColor: '#FF8303', color: '#FF8303' }
                : { borderBottomColor: 'transparent', color: '#6b7280' }
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'General Info' && <GeneralInfoTab />}
      {activeTab === 'Next Classes' && <NextClassesTab />}
      {activeTab === 'Past Classes' && <PastClassesTab />}
      {activeTab === 'Messages' && <MessagesTab />}

    </div>
  )
}
