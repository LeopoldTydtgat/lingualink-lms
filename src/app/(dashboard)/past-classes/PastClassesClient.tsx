'use client'

import { useCallback, useMemo, useState } from 'react'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { isCancelledStatus } from '@/lib/billing/billability'

// One ended lesson belonging to the viewing teacher. Flattened upstream: the
// student join is already flattened to student_name.
type PastLesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  student_name: string
}

// Completed report for a lesson. Supplies feedback text only - it is NEVER
// consulted for bucketing or for the status pill (see lessonBucket below).
type PastReport = {
  lesson_id: string
  feedback_text: string | null
}

type Props = {
  lessons: PastLesson[]
  // Display-only. An empty array is both "no feedback written" and the degraded
  // state upstream falls back to when the lookup fails; neither hides a class.
  reports: PastReport[]
  // Viewing teacher's own profiles.timezone (UTC display-only fallback upstream).
  // Every instant on this page projects through it.
  viewerTz: string
  // The lessons read itself failed. Distinct from an empty list: the page shows
  // an error banner rather than reading as "no past classes".
  loadFailed: boolean
  // The 1000-row ceiling was reached and older classes were dropped.
  capped: boolean
}

// Filter chips, in the order shown left-to-right.
const FILTERS = [
  'All',
  'Class taken',
  'Absent',
  'Missed',
  'No report',
  'Cancelled',
  'Rescheduled',
] as const

type Bucket = Exclude<(typeof FILTERS)[number], 'All'>

// Bucket a past lesson for the filter chips. Derived from lessons.status - the DB
// CHECK constraint is the authority here, NOT the report: a report can be absent,
// and a cancelled lesson never has one at all. Exactly one bucket per row.
//
// Rescheduled is its own bucket on purpose. A reschedule's dead leg is a
// cancelled-family row carrying rescheduled_by ('student' | 'admin'); folding it
// under Cancelled would tell the teacher a student cancelled when they in fact
// moved the class.
function lessonBucket(lesson: PastLesson): Bucket {
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

// Hours of notice between a cancellation and the class it cancelled. Whole
// hours below a day, whole days above. Instant-vs-instant in UTC ms - no local
// calendar date is involved, so no timezone projection is needed or wanted.
// Returns null when the cancellation instant is AFTER the class start (legacy
// or admin-cancelled-late rows): a negative notice is meaningless and must not
// render as "0h before".
function noticeLabel(cancelledAt: string, scheduledAt: string): string | null {
  const diffMs = new Date(scheduledAt).getTime() - new Date(cancelledAt).getTime()
  if (diffMs <= 0) return null
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `${minutes} min before`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h before`
  const days = Math.floor(hours / 24)
  return `${days}d before`
}

type Pill = { label: string; backgroundColor: string; color: string }

// Status pill for one past lesson. Cancelled-family rows defer to
// getCancellationLabel, which already returns 'Rescheduled by student' /
// 'Rescheduled by admin' for reschedule legs.
function statusPill(lesson: PastLesson): Pill {
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

export default function PastClassesClient({
  lessons,
  reports,
  viewerTz,
  loadFailed,
  capped,
}: Props) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('All')
  // null => use the default collapse (newest month expanded, all others collapsed).
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string> | null>(null)

  // All three formatters are pinned to the viewer's account zone. scheduled_at and
  // cancelled_at are timestamptz instants: without an explicit timeZone they render
  // in whatever zone the browser happens to sit in, not the teacher's own.
  const dateTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: viewerTz,
      }),
    [viewerTz]
  )

  // en-CA renders 'YYYY-MM', so the group key sorts lexically and matches the
  // collapsedMonths keys. Key and label come from the same zoned formatting of the
  // same instant, so they can never disagree about which month a class fell in.
  const monthKeyFmt = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: viewerTz, year: 'numeric', month: '2-digit' }),
    [viewerTz]
  )
  const monthLabelFmt = useMemo(
    () => new Intl.DateTimeFormat('en-GB', { timeZone: viewerTz, month: 'long', year: 'numeric' }),
    [viewerTz]
  )

  // Local helper 1: full date + time for an instant, in the viewer's zone. Used for
  // BOTH scheduled_at and cancelled_at - the cancellation TIME is a client
  // requirement, the date alone is not enough.
  function formatDateTime(instant: string) {
    return dateTimeFmt.format(new Date(instant))
  }

  // Local helper 2: the month bucket for an instant, in the viewer's zone, so a
  // boundary instant cannot land in the wrong month group. useCallback rather than a
  // plain function because the grouping memo below depends on it.
  const formatMonth = useCallback(
    (instant: string) => {
      const d = new Date(instant)
      return { key: monthKeyFmt.format(d), label: monthLabelFmt.format(d) }
    },
    [monthKeyFmt, monthLabelFmt]
  )

  const reportsByLessonId = useMemo(() => {
    const map: Record<string, PastReport> = {}
    for (const r of reports) map[r.lesson_id] = r
    return map
  }, [reports])

  // Chip counts come from the FULL lesson set - never the filtered or searched
  // view, so typing in the search box cannot move the numbers on the chips.
  const counts = useMemo(() => {
    const c: Record<string, number> = {
      All: lessons.length,
      'Class taken': 0,
      Absent: 0,
      Missed: 0,
      'No report': 0,
      Cancelled: 0,
      Rescheduled: 0,
    }
    for (const l of lessons) c[lessonBucket(l)] += 1
    return c
  }, [lessons])

  // Search applies AFTER the chip filter, and only to the visible list.
  const visible = useMemo(() => {
    const byChip = filter === 'All' ? lessons : lessons.filter((l) => lessonBucket(l) === filter)
    const q = search.trim().toLowerCase()
    if (q === '') return byChip
    return byChip.filter((l) => l.student_name.toLowerCase().includes(q))
  }, [lessons, filter, search])

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; lessons: PastLesson[] }>()
    for (const lesson of visible) {
      const { key, label } = formatMonth(lesson.scheduled_at)
      let group = map.get(key)
      if (!group) {
        group = { key, label, lessons: [] }
        map.set(key, group)
      }
      group.lessons.push(lesson)
    }
    const out = [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1))
    for (const g of out) {
      g.lessons.sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime())
    }
    return out
  }, [visible, formatMonth])

  // Default collapse: newest month expanded, all others collapsed. The null state
  // uses this, so switching chip resets back to it.
  const defaultCollapsed = useMemo(() => new Set(groups.slice(1).map((g) => g.key)), [groups])
  const searching = search.trim() !== ''
  // While searching, force every month expanded so a match inside an otherwise-
  // collapsed month is actually visible. This only overrides which groups render
  // collapsed - collapsedMonths itself is untouched, so clearing the search box
  // restores the user's manual collapse state exactly as they left it.
  const effectiveCollapsed = searching ? new Set<string>() : collapsedMonths ?? defaultCollapsed

  function toggleMonth(key: string) {
    setCollapsedMonths((prev) => {
      const next = new Set(prev ?? defaultCollapsed)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="space-y-6">

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Past Classes</h1>
        <p className="text-sm text-gray-500 mt-1">
          Every class you have taught, missed or had cancelled.
        </p>
      </div>

      {!loadFailed && capped && (
        <p className="text-xs text-gray-400">
          Showing your 1000 most recent classes. Older classes are not listed.
        </p>
      )}

      {loadFailed ? (
        // Rendered INSTEAD of the empty state: a failed read must never read as
        // "you have no past classes".
        <div
          className="rounded-xl p-4 text-sm"
          style={{ backgroundColor: '#FFEEE6', color: '#B91C1C', border: '1px solid #FECACA' }}
        >
          Your past classes could not be loaded. Please refresh the page to try again.
        </div>
      ) : lessons.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">No past classes yet.</p>
      ) : (
        <div className="space-y-4">

          <input
            type="text"
            placeholder="Search by student name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />

          {/* Filter chips */}
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => {
              const active = filter === f
              return (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setCollapsedMonths(null) }}
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

          {groups.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No classes match this filter.</p>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const collapsed = effectiveCollapsed.has(group.key)
                return (
                  <div key={group.key} className="space-y-3">
                    <button
                      onClick={() => toggleMonth(group.key)}
                      aria-expanded={!collapsed}
                      className="w-full flex items-center justify-between px-1 py-1 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <svg
                          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          className="text-gray-400"
                          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                        >
                          <path d="M6 9l6 6 6-6"/>
                        </svg>
                        <span className="font-semibold text-gray-900">{group.label}</span>
                      </span>
                      <span className="text-xs text-gray-500">
                        {group.lessons.length} {group.lessons.length === 1 ? 'class' : 'classes'}
                      </span>
                    </button>

                    {!collapsed && (
                      <div className="space-y-3">
                        {group.lessons.map((lesson) => {
                          const cancelled = isCancelledStatus(lesson.status)
                          const pill = statusPill(lesson)
                          const report = reportsByLessonId[lesson.id]
                          const rescheduled = cancelled && lesson.rescheduled_by != null
                          const reason = lesson.cancellation_reason?.trim() ?? ''
                          // Null when there is no cancellation instant, or when the cancellation landed
                          // after the class had already started (see noticeLabel).
                          const notice = lesson.cancelled_at
                            ? noticeLabel(lesson.cancelled_at, lesson.scheduled_at)
                            : null
                          return (
                            <div
                              key={lesson.id}
                              className="bg-white rounded-xl shadow-sm p-4"
                              style={{ border: '1px solid #f3f4f6' }}
                            >
                              <div className="flex items-start justify-between gap-3 mb-2">
                                <div>
                                  <p className="font-medium text-gray-900">{formatDateTime(lesson.scheduled_at)}</p>
                                  <p className="text-sm text-gray-600">{lesson.student_name}</p>
                                </div>
                                <span
                                  className="text-xs px-2 py-1 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: pill.backgroundColor, color: pill.color }}
                                >
                                  {pill.label}
                                </span>
                              </div>

                              <p className="text-xs text-gray-500">{lesson.duration_minutes} min</p>

                              {cancelled && lesson.cancelled_at && (
                                <p className="text-xs text-gray-500 mt-1">
                                  {rescheduled ? 'Rescheduled ' : 'Cancelled '}
                                  {formatDateTime(lesson.cancelled_at)}
                                  {notice !== null ? ` - ${notice}` : ''}
                                  {reason !== '' && reason !== pill.label ? ` (${reason})` : ''}
                                </p>
                              )}

                              {/* Full feedback, never clamped: this page is the
                                  teacher's permanent record of the class. */}
                              {!cancelled && report?.feedback_text && (
                                <p className="text-sm text-gray-600 mt-2 italic whitespace-pre-line">
                                  &ldquo;{report.feedback_text}&rdquo;
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
