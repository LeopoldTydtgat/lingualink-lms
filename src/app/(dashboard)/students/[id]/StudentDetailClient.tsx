'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { isCancelledStatus } from '@/lib/billing/billability'
import { formatDayDate, formatMonth, formatDayDivider, formatTimeOfDay } from '@/lib/lessons/agendaDates'
import { getLocalDateKey } from '@/lib/utils/timezone'
import {
  computeOverallLevel,
  hasUsableLevelData,
} from '@/lib/levels/levelData'
import LevelTracks from '@/components/shared/LevelTracks'

type Student = {
  id: string
  full_name: string
  photo_url: string | null
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
  profiles: { full_name: string; photo_url: string | null } | null
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

// One study sheet assigned FOR a specific class, as shown in the Past Classes
// recap. Deliberately NOT an Assignment: it is keyed to a lesson rather than to
// the student, and carries no completion state (the completion view lives in the
// General Info table above). category/level are nullable on study_sheets.
type LessonSheet = {
  id: string
  title: string
  category: string | null
  level: string | null
}

// One live teaching-material homework grant. Deliberately NOT an Assignment:
// a material grant carries no completion state and no sheet metadata (the sheet
// is audience='staff'), only a page range and whether the student has drawn on it
// yet. `hasWork` is derived server-side so the student's annotation layer itself
// never reaches this bundle.
type MaterialHomework = {
  id: string
  title: string
  page_start: number | null
  page_end: number | null
  assigned_at: string
  hasWork: boolean
}

type Props = {
  training: Training
  upcomingLessons: Lesson[]
  pastLessons: Lesson[]
  reports: Report[]
  // Study sheets assigned for each class, keyed by lessons.id. Display-only; an
  // empty map is both "nothing assigned" and the degraded state upstream falls
  // back to when the lookup fails, and neither hides a class from the tab.
  sheetsByLessonId: Record<string, LessonSheet[]>
  isAdmin: boolean
  // Viewing teacher's own profiles.timezone (UTC display-only fallback upstream).
  // Instant labels project through this; date-only labels stay UTC-pinned.
  viewerTz: string
  currentUserId: string
  assignments: Assignment[]
  assignedTeacherNames: string[]
  materialAssignments: MaterialHomework[]
  // The homework query failed upstream. Distinct from an empty list: the section
  // shows an error note rather than silently reading as "no homework".
  materialLoadFailed: boolean
}

const TABS = ['General Info', 'Next Classes', 'Past Classes', 'Messages']

// Past Classes filter chips (order shown left-to-right). Same set, same order as
// the teacher's own Past Classes page, so the two surfaces read as one product.
const PAST_FILTERS = [
  'All',
  'Class taken',
  'Absent',
  'Missed',
  'No report',
  'Cancelled',
  'Rescheduled',
] as const

type PastBucket = Exclude<(typeof PAST_FILTERS)[number], 'All'>

// Bucket a past lesson for the filter chips. Derived from lessons.status - the DB
// CHECK constraint is the authority here, NOT the report. This REPLACED a
// report-derived bucketer, deliberately: a report cannot distinguish 'missed'
// (class happened, paperwork abandoned) from 'no report yet', and it folded a
// reschedule's dead leg in with genuine cancellations. Exactly one bucket per row.
//
// Twin of lessonBucket in (dashboard)/past-classes/PastClassesClient.tsx - keep
// the two in step.
function lessonBucket(lesson: Lesson): PastBucket {
  if (isCancelledStatus(lesson.status)) {
    return lesson.rescheduled_by != null ? 'Rescheduled' : 'Cancelled'
  }
  if (lesson.status === 'completed') return 'Class taken'
  if (lesson.status === 'student_no_show' || lesson.status === 'teacher_no_show') return 'Absent'
  if (lesson.status === 'missed') return 'Missed'
  // An ended lesson still sitting at 'scheduled': the class happened but the
  // report has not been filed (and the overdue cron has not yet flipped it).
  return 'No report'
}

// Bare notice magnitude between a cancellation and the class it cancelled -
// e.g. "18 min", "17h", "2d". Whole hours below a day, whole days above.
// Instant-vs-instant in UTC ms - no local calendar date is involved, so no
// timezone projection is needed or wanted. Returns null when the cancellation
// instant is AFTER the class start (legacy or admin-cancelled-late rows): a
// negative notice is meaningless and must not render as "0h".
//
// Twin of noticeLabel in (dashboard)/past-classes/PastClassesClient.tsx.
function noticeLabel(cancelledAt: string, scheduledAt: string): string | null {
  const diffMs = new Date(scheduledAt).getTime() - new Date(cancelledAt).getTime()
  if (diffMs <= 0) return null
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

type Pill = { label: string; backgroundColor: string; color: string }

// Status pill for one past lesson. Cancelled-family rows defer to
// getCancellationLabel, which already returns 'Rescheduled by student' /
// 'Rescheduled by admin' for reschedule legs.
//
// Twin of statusPill in (dashboard)/past-classes/PastClassesClient.tsx. Kept as a
// local copy rather than shared: it is typed against THIS file's Lesson, and
// cross-importing a helper between two page components is worse than one small
// duplicate. Keep the labels and colours identical.
function statusPill(lesson: Lesson): Pill {
  if (isCancelledStatus(lesson.status)) {
    return {
      label: getCancellationLabel(lesson, 'teacher') ?? 'Cancelled',
      backgroundColor: '#f3f4f6',
      color: '#6b7280',
    }
  }
  switch (lesson.status) {
    case 'completed':
      return { label: 'Class taken', backgroundColor: '#DCFCE7', color: '#15803D' }
    case 'student_no_show':
      return { label: 'Student absent', backgroundColor: '#FFF8E8', color: '#B45309' }
    case 'teacher_no_show':
      return { label: 'Teacher absent', backgroundColor: '#FFEEE6', color: '#FD5602' }
    case 'missed':
      return { label: 'Missed - no report', backgroundColor: '#FFF8E8', color: '#B45309' }
    default:
      return { label: 'No report', backgroundColor: '#f3f4f6', color: '#6b7280' }
  }
}

// Page-range label for a material homework grant. page_start / page_end are
// 1-based and inclusive; both null means the whole document. A half-null range is
// forbidden by the table's CHECK constraint but is labelled defensively rather
// than rendering an empty badge. Mirrors the student portal's own label helper.
function pageRangeLabel(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null && pageEnd === null) return 'Whole document'
  if (pageStart !== null && pageEnd !== null) {
    return pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`
  }
  return `Page ${pageStart ?? pageEnd}`
}

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
  sheetsByLessonId,
  viewerTz,
  assignments,
  assignedTeacherNames,
  materialAssignments,
  materialLoadFailed,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState('General Info')
  const student = training.students
  const [notes, setNotes] = useState(student?.teacher_notes ?? '')
  const [savedNotes, setSavedNotes] = useState(student?.teacher_notes ?? '')
  const [editingNotes, setEditingNotes] = useState(false)
  const [isSavingNotes, setIsSavingNotes] = useState(false)
  const [notesError, setNotesError] = useState('')
  const [pastFilter, setPastFilter] = useState<string>('All')
  // Today's date key in the VIEWER's timezone, for the Past Classes day divider.
  // TOP LEVEL on purpose: the tabs below are INVOKED as functions, so a hook placed
  // inside PastClassesTab would become a conditional hook of this component and throw
  // the moment the teacher switches tabs. Set in the effect, never during render:
  // react-hooks/purity would reject a clock read in a render body, and it would also
  // make the SSR pass disagree with hydration. Null until mounted, which the divider
  // treats as "no relative label".
  const [todayKey, setTodayKey] = useState<string | null>(null)

  useEffect(() => {
    // Named read rather than a bare setState in the effect body, the shape the agenda
    // lists already use: the clock is an external system being sampled, not state
    // derived from props, and react-hooks/set-state-in-effect only reads it that way
    // once the sample is a named operation. Set once - the Past Classes tab is
    // history, so it has no group whose label goes stale at local midnight.
    function syncTodayKey() {
      setTodayKey(getLocalDateKey(new Date(), viewerTz))
    }
    syncTodayKey()
  }, [viewerTz])

  async function handleSaveNotes() {
    if (!student) return
    setNotesError('')
    setIsSavingNotes(true)
    // The finally already guaranteed the button recovers, but without a catch a
    // rejection was swallowed silently: fetch() rejects on a network fault, and the
    // res.json() below is unguarded, so an ok response with a non-JSON body rejects
    // too. Either one left the editor open with the typed text and NO message, so a
    // save that never happened looked the same as one that did. The text is still in
    // the box either way, which is why this shows an error rather than restoring state.
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
    } catch {
      setNotesError('Could not reach the server. Your notes were NOT saved - please try again.')
    } finally {
      setIsSavingNotes(false)
    }
  }

  function getInitials(name: string) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  // Date-only DATE columns (trainings.start_date/end_date) parse as UTC midnight, so the
  // label must be pinned to UTC or any browser west of UTC renders the previous day.
  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      timeZone: 'UTC',
    })
  }

  // Instant (timestamptz) rendered as a date label in the VIEWER's zone - do not
  // route instants through the UTC-pinned formatDate above.
  function formatInstantDate(dateStr: string | null, viewerTz: string) {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: viewerTz,
    })
  }

  // lessons.scheduled_at is a timestamptz instant; without a timeZone option it rendered
  // in whatever zone the browser sat in, not the teacher's account zone.
  function formatDateTime(dateStr: string) {
    return new Date(dateStr).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: viewerTz,
    })
  }

  const hoursRemaining = training.total_hours - training.hours_consumed
  const progressPercent = training.total_hours > 0
    ? Math.round((training.hours_consumed / training.total_hours) * 100)
    : 0

  const reportsByLessonId = Object.fromEntries(
    reports.map(r => [r.lesson_id, r])
  )

  // The most recent completed report on this training that actually carries a
  // usable level assessment. NOT simply reports[0]: the array is ordered by
  // completed_at descending, and a completed no-show report stores level_data
  // null, so taking the newest row would blank the student's level the moment a
  // no-show is filed. Same predicate the student Progress page uses to choose
  // its row, so teacher and student can never display different levels.
  // Plain derivation, no hook - see the constraint on GeneralInfoTab.
  const latestLevelReport = reports.find(r => hasUsableLevelData(r.level_data)) ?? null
  const levelOverall = computeOverallLevel(latestLevelReport?.level_data ?? null)

  // ── TAB: General Info ──────────────────────────────────────────
  function GeneralInfoTab() {
    return (
      <div className="space-y-8">

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

        <div>
          <div className="flex items-center gap-2 mb-3">
            <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <h3 className="text-base font-semibold text-gray-900">Training Details</h3>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3" style={{ border: '1px solid #f3f4f6' }}>
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
                <p className="text-gray-500">Timezone</p>
                <p className="font-medium text-gray-900">{student?.timezone ?? '—'}</p>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <h3 className="text-base font-semibold text-gray-900">Learning Profile</h3>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3" style={{ border: '1px solid #f3f4f6' }}>
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
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <h3 className="text-base font-semibold text-gray-900">Student Level</h3>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
            {latestLevelReport ? (
              <>
                <p className="text-xs text-gray-400 mb-4">
                  From the class report of {formatInstantDate(latestLevelReport.completed_at, viewerTz)}
                </p>
                {levelOverall && (
                  <div className="flex flex-col items-center" style={{ marginBottom: '20px' }}>
                    <p
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#9ca3af',
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        margin: 0,
                      }}
                    >
                      Overall Level
                    </p>
                    <p style={{ fontSize: '40px', fontWeight: 700, color: '#FF8303', lineHeight: 1.1, margin: '4px 0 0 0' }}>
                      {levelOverall}
                    </p>
                  </div>
                )}
                <LevelTracks levelData={latestLevelReport.level_data} />
                <p className="text-xs text-center mt-4" style={{ color: '#9ca3af' }}>
                  Scale: A1 &#8594; A2 &#8594; B1 &#8594; B2 &#8594; C1 &#8594; C2
                </p>
              </>
            ) : (
              <p className="text-sm text-center" style={{ color: '#9ca3af' }}>
                No level assessment yet. It will appear here once a class report with
                a level assessment has been submitted.
              </p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
              <h3 className="text-base font-semibold text-gray-900">Notes</h3>
            </div>
            {!editingNotes && (
              <button
                onClick={() => setEditingNotes(true)}
                className="text-xs px-3 py-1 rounded border border-gray-300 hover:border-gray-400 text-gray-600"
              >
                Edit
              </button>
            )}
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
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
        </div>

        {/* ── Assigned Study Sheets (read-only) ── */}
        {assignments.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
              <h3 className="text-base font-semibold text-gray-900">
                Assigned Study Sheets
                <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{assignments.length}</span>
              </h3>
            </div>
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

        {/* -- Homework (teaching-material grants, view-only) -- */}
        {/* Rendered when there is something to say: live grants, or a failed
            lookup. An empty list stays silent, exactly like the block above. */}
        {(materialLoadFailed || materialAssignments.length > 0) && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
              <h3 className="text-base font-semibold text-gray-900">
                Homework
                {!materialLoadFailed && (
                  <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{materialAssignments.length}</span>
                )}
              </h3>
            </div>
            <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f3f4f6' }}>
              {materialLoadFailed ? (
                <p className="px-4 py-3 text-sm" style={{ color: '#FD5602' }}>
                  Could not load this student&apos;s homework. Please refresh the page.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-3 font-medium text-gray-500">Material</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500">Pages</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500">Date Assigned</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-500">Student Work</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {materialAssignments.map(m => (
                      <tr key={m.id} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-3 font-medium text-gray-900">{m.title}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: '#FFF0E0', color: '#FF8303' }}>
                            {pageRangeLabel(m.page_start, m.page_end)}
                          </span>
                        </td>
                        {/* assigned_at is a timestamptz INSTANT — formatInstantDate projects it
                            into the viewer's own zone. Never formatDate, which is UTC-pinned
                            for the DATE columns on trainings. */}
                        <td className="px-4 py-3 text-gray-500">{formatInstantDate(m.assigned_at, viewerTz)}</td>
                        <td className="px-4 py-3">
                          {/* State colours as inline styles — Tailwind v4 never applies a
                              dynamically constructed colour class. */}
                          <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: m.hasWork ? '#FF8303' : '#9ca3af' }}>
                            <span style={{ width: '7px', height: '7px', borderRadius: '9999px', backgroundColor: m.hasWork ? '#FF8303' : '#9ca3af', flexShrink: 0 }} />
                            {m.hasWork ? 'Has work' : 'Untouched'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/students/${training.id}/homework/${m.id}`}
                            prefetch={false}
                            className="text-xs font-semibold"
                            style={{ color: '#FF8303' }}
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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

    // Day-only, no year: used for the cancellation line only, where the month
    // separator above already carries the year and the divider carries the date.
    // Pinned to viewerTz like every other instant on this tab. A plain const, NOT
    // useMemo - this tab is INVOKED as a function (see the tab block at the bottom
    // of the file), so any hook here would become a conditional hook of
    // StudentDetailClient and break the Rules of Hooks.
    const cancelDayFmt = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: viewerTz,
    })

    // Chip counts from the FULL past set, never the filtered view, so picking a
    // chip cannot move the numbers printed on the chips.
    const counts: Record<string, number> = {
      All: pastLessons.length,
      'Class taken': 0,
      Absent: 0,
      Missed: 0,
      'No report': 0,
      Cancelled: 0,
      Rescheduled: 0,
    }
    for (const l of pastLessons) counts[lessonBucket(l)] += 1

    // Filtered set that feeds the grouped view.
    const filtered = pastFilter === 'All'
      ? pastLessons
      : pastLessons.filter(l => lessonBucket(l) === pastFilter)

    // Flat agenda, one group per calendar DAY - the same shape the teacher's own
    // Past Classes page uses, so the two surfaces read as one product. The key
    // comes from getLocalDateKey in the viewer's own zone, the same zone the
    // divider label below is formatted in, so the key and its label agree by
    // construction and a boundary instant cannot land under the wrong date.
    //
    // Days sort DESCENDING and rows sort descending within a day: this is history,
    // the exact opposite of Next Classes. Newest class first, always.
    const dayMap = new Map<string, Lesson[]>()
    for (const lesson of filtered) {
      const key = getLocalDateKey(new Date(lesson.scheduled_at), viewerTz)
      const bucket = dayMap.get(key)
      if (bucket) bucket.push(lesson)
      else dayMap.set(key, [lesson])
    }
    // The bucket arrays are built here by push, so sorting them in place never
    // touches the pastLessons prop array that `filtered` can pass straight through.
    const days = [...dayMap.entries()].map(([key, dayLessons]) => {
      dayLessons.sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime())
      return { key, lessons: dayLessons }
    })
    days.sort((a, b) => (a.key < b.key ? 1 : -1))

    return (
      <div className="space-y-4">
        {/* Filter chips */}
        <div className="flex flex-wrap gap-2">
          {PAST_FILTERS.map(f => {
            const active = pastFilter === f
            return (
              <button
                key={f}
                onClick={() => setPastFilter(f)}
                className="text-xs px-3 py-1.5 rounded-full border transition-colors"
                style={
                  active
                    ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                    : { backgroundColor: 'white', color: '#6b7280', borderColor: '#d1d5db' }
                }
              >
                {f}
                <span className="ml-1.5 opacity-80">{counts[f]}</span>
              </button>
            )
          })}
        </div>

        {days.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-12">No classes match this filter.</p>
        ) : (
          <div className="space-y-5">
            {days.map((day, dayIndex) => {
              // Every calendar month in the list carries its header, the first one
              // included: two structurally identical months must not look different,
              // and in a flat agenda 1 Sept and 31 Aug are otherwise indistinguishable
              // neighbours. The first day has no previous day to compare against, so it
              // counts as a month change by definition. Months are compared on the day
              // keys, which getLocalDateKey already built in the viewer's timezone, so
              // the comparison and the text below it agree by construction.
              const showMonthSeparator =
                dayIndex === 0 || day.key.slice(0, 7) !== days[dayIndex - 1].key.slice(0, 7)
              const firstOfDay = day.lessons[0]

              return (
                <div key={day.key}>
                  {showMonthSeparator && (
                    <p
                      style={{
                        // The first header already has the chip row's gap above it; only
                        // a mid-list month break has to open a break of its own.
                        margin: dayIndex === 0 ? '0 0 10px' : '28px 0 10px',
                        paddingBottom: '6px',
                        paddingLeft: '2px',
                        borderBottom: '1px solid #E0DFDC',
                        fontSize: '13px',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        color: '#111827',
                      }}
                    >
                      {formatMonth(firstOfDay.scheduled_at, viewerTz)}
                    </p>
                  )}
                  {/* Slim text divider, not a card and not a control: nothing collapses
                      on this tab any more, so it carries no chevron and no class count.
                      Pre-mount it prints the absolute date rather than a bare date key;
                      formatDayDate is deterministic on server and client, so SSR and the
                      first client pass still match. Once the effect at the top of this
                      component supplies todayKey the divider swaps to formatDayDivider;
                      on a past-only list 'Tomorrow' is unreachable and 'Today' is
                      reachable, both of which formatDayHeading handles. */}
                  <p
                    style={{
                      margin: '0 0 6px 2px',
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: '#9ca3af',
                    }}
                  >
                    {todayKey === null
                      ? formatDayDate(firstOfDay.scheduled_at, viewerTz)
                      : formatDayDivider(firstOfDay.scheduled_at, viewerTz, day.key, todayKey)}
                  </p>
                  <div className="card-elevated overflow-hidden">
                    {day.lessons.map((lesson, i) => {
                      const cancelled = isCancelledStatus(lesson.status)
                      const pill = statusPill(lesson)
                      const report = reportsByLessonId[lesson.id]
                      // Plain lookup, deliberately not memoised - see cancelDayFmt above
                      // for why nothing in this tab may be a hook.
                      const lessonSheets = sheetsByLessonId[lesson.id] ?? []
                      // DELIBERATE DIFFERENCE from the teacher's Past Classes page: the
                      // varying party per row HERE is the teacher, not the student. This
                      // is one student's detail page and the header above already names
                      // them, so the avatar and heading carry whoever taught the class.
                      const teacherName = lesson.profiles?.full_name ?? 'Unknown teacher'
                      const rescheduled = cancelled && lesson.rescheduled_by != null
                      const reason = lesson.cancellation_reason?.trim() ?? ''
                      // Null when there is no cancellation instant, or when the
                      // cancellation landed after the class had already started (see
                      // noticeLabel).
                      const notice = lesson.cancelled_at
                        ? noticeLabel(lesson.cancelled_at, lesson.scheduled_at)
                        : null
                      // There is no ends_at column on this page, so the end is derived by
                      // adding the duration to the start. Instant arithmetic in UTC ms,
                      // NOT local date construction - the toISOString() ban covers
                      // building a local calendar date, which this is not.
                      const endIso = new Date(
                        new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60000
                      ).toISOString()

                      return (
                        <div
                          key={lesson.id}
                          className="bg-white"
                          style={{ borderTop: i === 0 ? 'none' : '1px solid #f3f4f6' }}
                        >
                          {/* items-start, not items-center: a row here can carry a
                              cancellation line, unclamped feedback and an assigned-sheet
                              list under its time line, and centring would float the
                              avatar and the pill in the middle of a tall row. */}
                          <div className="w-full flex items-start gap-4 p-4 text-left">
                            {/* Plain div, NEVER a Link: this IS the student's detail
                                page, and the row's varying party is a teacher, who has
                                no teacher-facing destination in this portal. */}
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
                              style={{ backgroundColor: '#FFE8C2' }}
                            >
                              {lesson.profiles?.photo_url ? (
                                <img
                                  src={lesson.profiles.photo_url}
                                  alt={teacherName}
                                  className="w-10 h-10 rounded-full object-cover"
                                />
                              ) : (
                                <span className="font-semibold text-sm" style={{ color: '#FF8303' }}>
                                  {teacherName.charAt(0)}
                                </span>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="font-semibold">By {teacherName}</p>
                              {/* Time only: the divider above the group carries the date
                                  for every row beneath it. */}
                              <p className="text-sm text-gray-500">
                                {`${formatTimeOfDay(lesson.scheduled_at, viewerTz)} - ${formatTimeOfDay(endIso, viewerTz)} · ${lesson.duration_minutes} min`}
                              </p>

                              {cancelled && lesson.cancelled_at && (
                                <p className="text-xs text-gray-500 mt-1">
                                  {rescheduled ? 'Rescheduled' : 'Cancelled'} on{' '}
                                  {cancelDayFmt.format(new Date(lesson.cancelled_at))} at{' '}
                                  {formatTimeOfDay(lesson.cancelled_at, viewerTz)}
                                  {notice !== null ? `, ${notice} before the class` : ''}
                                  {reason !== '' && reason !== pill.label ? ` (${reason})` : ''}
                                </p>
                              )}

                              {/* Full feedback, not clamped: this tab is the teacher's
                                  pre-class catch-up read, and a 2-line preview with no
                                  way to expand hid most of it. */}
                              {!cancelled && report?.feedback_text && (
                                <p className="text-sm text-gray-600 mt-2 italic whitespace-pre-line">
                                  &ldquo;{report.feedback_text}&rdquo;
                                </p>
                              )}

                              {!cancelled && lessonSheets.length > 0 && (
                                <div className="mt-3">
                                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                                    Assigned for next time
                                  </p>
                                  <ul className="space-y-0.5">
                                    {lessonSheets.map(sheet => (
                                      <li key={sheet.id} className="text-xs text-gray-700">
                                        {sheet.title}
                                        {(sheet.category || sheet.level) && (
                                          <span className="text-gray-400">
                                            {sheet.category ? ` · ${sheet.category}` : ''}
                                            {sheet.level ? ` · ${sheet.level}` : ''}
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>

                            <span
                              className="flex-shrink-0"
                              style={{
                                fontSize: '11px',
                                fontWeight: 600,
                                padding: '2px 8px',
                                borderRadius: '4px',
                                backgroundColor: pill.backgroundColor,
                                color: pill.color,
                              }}
                            >
                              {pill.label}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
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
            className="w-[72px] h-[72px] rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <div
            className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
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
