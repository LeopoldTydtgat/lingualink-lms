'use client'

import { useEffect, useMemo, useState } from 'react'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { isCancelledStatus } from '@/lib/billing/billability'
import { formatDayDate, formatMonth, formatDayDivider, formatTimeOfDay } from '@/lib/lessons/agendaDates'
import { getLocalDateKey } from '@/lib/utils/timezone'

// One ended lesson belonging to the viewing teacher. Flattened upstream: the
// student join is already flattened to student_name / student_photo_url.
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
  student_photo_url: string | null
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

// Bare notice magnitude between a cancellation and the class it cancelled -
// e.g. "18 min", "17h", "2d". Whole hours below a day, whole days above.
// Instant-vs-instant in UTC ms - no local calendar date is involved, so no
// timezone projection is needed or wanted. Returns null when the cancellation
// instant is AFTER the class start (legacy or admin-cancelled-late rows): a
// negative notice is meaningless and must not render as "0h".
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
  // Today's date key in the VIEWER's timezone, for the Today divider label. Set in
  // the effect, never during render: react-hooks/purity is ON in this file and a
  // clock read in a render body would also make the SSR pass disagree with
  // hydration. Null until mounted, which the divider treats as "no relative label".
  const [todayKey, setTodayKey] = useState<string | null>(null)

  useEffect(() => {
    // Named read rather than a bare setState in the effect body, the shape both
    // agenda lists already use (UpcomingClassesClient, MyClassesClient): the clock
    // is the external system being sampled here, not state derived from props, and
    // react-hooks/set-state-in-effect only reads it that way once the sample is a
    // named operation. Set once - this page is history, so unlike those two lists it
    // has no group whose label goes stale at local midnight.
    function syncTodayKey() {
      setTodayKey(getLocalDateKey(new Date(), viewerTz))
    }
    syncTodayKey()
  }, [viewerTz])

  // Pinned to the viewer's account zone. scheduled_at and cancelled_at are
  // timestamptz instants: without an explicit timeZone they render in whatever zone
  // the browser happens to sit in, not the teacher's own.
  //
  // Day-only, no year: used for the cancellation line only, where the month
  // separator above already carries the year. The class's own start is printed
  // as a time range by the row instead, under a divider that already carries
  // its date. Time comes from the shared formatTimeOfDay helper, not a second
  // formatter here.
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: viewerTz,
      }),
    [viewerTz]
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

  // Flat agenda, one group per calendar DAY - the same shape the teacher's Upcoming
  // Classes list uses, so the two pages read as one product. The key comes from
  // getLocalDateKey in the viewer's own zone, the same helper Upcoming uses and the
  // same zone the divider label below is formatted in, so the key and its label agree
  // by construction and a boundary instant cannot land under the wrong date.
  //
  // Days sort DESCENDING and rows sort descending within a day: this is history, the
  // exact opposite of Upcoming's ascending order. Newest class first, always.
  const days = useMemo(() => {
    const map = new Map<string, PastLesson[]>()
    for (const lesson of visible) {
      const key = getLocalDateKey(new Date(lesson.scheduled_at), viewerTz)
      const bucket = map.get(key)
      if (bucket) bucket.push(lesson)
      else map.set(key, [lesson])
    }
    // The bucket arrays are built here by push, so sorting them in place never
    // touches the `lessons` prop array `visible` can pass straight through.
    const out = [...map.entries()].map(([key, dayLessons]) => {
      dayLessons.sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime())
      return { key, lessons: dayLessons }
    })
    out.sort((a, b) => (a.key < b.key ? 1 : -1))
    return out
  }, [visible, viewerTz])

  // Header counts come from the FULL lesson set, never the filtered or searched view,
  // exactly like the chip counts: the subtitle states what this teacher's history
  // holds, not what the current chip happens to show.
  const cancelledCount = useMemo(
    () => lessons.filter((l) => isCancelledStatus(l.status)).length,
    [lessons]
  )

  return (
    <div className="space-y-6">

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Past Classes</h1>
        <p className="text-sm text-gray-500 mt-1">
          {lessons.length} {lessons.length === 1 ? 'class' : 'classes'}
          {cancelledCount > 0 && (
            <>
              {' '}&middot;{' '}
              <span className="font-medium" style={{ color: '#FF8303' }}>
                {cancelledCount} cancelled
              </span>
            </>
          )}
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
                  onClick={() => setFilter(f)}
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
                //
                // No mount gate: formatMonth is pure and takes its zone as an argument, so
                // the server and the first client pass emit the same string.
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
                        on this page, so it carries no chevron and no lesson count.
                        DELIBERATE DEVIATION from Upcoming, which prints the raw date key
                        until it mounts: pre-mount this prints the absolute date instead.
                        formatDayDate is deterministic on server and client, so SSR and the
                        first client pass still match, and the teacher never sees a bare
                        '2026-08-21'. Once the effect supplies todayKey the divider swaps to
                        formatDayDivider; on a past-only list 'Tomorrow' is unreachable and
                        'Today' is reachable, both of which formatDayHeading handles. */}
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
                        const rescheduled = cancelled && lesson.rescheduled_by != null
                        const reason = lesson.cancellation_reason?.trim() ?? ''
                        // Null when there is no cancellation instant, or when the cancellation landed
                        // after the class had already started (see noticeLabel).
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
                            {/* items-start, not Upcoming's items-center: a row here can carry a
                                cancellation line and an unclamped feedback block under its time
                                line, and centring would float the avatar and the pill in the
                                middle of a tall row. */}
                            <div className="w-full flex items-start gap-4 p-4 text-left">
                              {/* Plain div, NOT a Link to /students/[training_id]: that page's
                                  teacher access gate requires an active claim - an upcoming
                                  lesson or an open report - which a past-only student does not
                                  have, so the link would 404 for most rows on this page. */}
                              <div
                                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
                                style={{ backgroundColor: '#FFE8C2' }}
                              >
                                {lesson.student_photo_url ? (
                                  <img
                                    src={lesson.student_photo_url}
                                    alt={lesson.student_name}
                                    className="w-10 h-10 rounded-full object-cover"
                                  />
                                ) : (
                                  <span className="font-semibold text-sm" style={{ color: '#FF8303' }}>
                                    {lesson.student_name.charAt(0)}
                                  </span>
                                )}
                              </div>

                              <div className="flex-1 min-w-0">
                                <p className="font-semibold">{lesson.student_name}</p>
                                {/* Time only: the divider above the group carries the date for
                                    every row beneath it. */}
                                <p className="text-sm text-gray-500">
                                  {`${formatTimeOfDay(lesson.scheduled_at, viewerTz)} - ${formatTimeOfDay(endIso, viewerTz)} · ${lesson.duration_minutes} min`}
                                </p>

                                {cancelled && lesson.cancelled_at && (
                                  <p className="text-xs text-gray-500 mt-1">
                                    {rescheduled ? 'Rescheduled' : 'Cancelled'} on{' '}
                                    {dayFmt.format(new Date(lesson.cancelled_at))} at{' '}
                                    {formatTimeOfDay(lesson.cancelled_at, viewerTz)}
                                    {notice !== null ? `, ${notice} before the class` : ''}
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
      )}

    </div>
  )
}
