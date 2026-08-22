'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { checkAllowedDuration } from '@/lib/lessons/allowedDurations'
import { formatInstantInTz } from '@/lib/exportTime'
import { DateRangeFilter } from '../_components/DateRangeFilter'
import { useFilterPersistence } from '@/lib/hooks/useFilterPersistence'

interface Teacher {
  id: string
  full_name: string
}

interface Lesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  teams_join_url: string | null
  teacher_id: string
  student_id: string
  teacher: { id: string; full_name: string; photo_url: string | null } | null
  // allowed_durations is `unknown` on purpose. This interface describes an
  // UNVALIDATED fetch body - GET /api/admin/classes returns raw PostgREST output
  // and nothing checks it on either side of the wire - so asserting number[] here
  // would be a claim the route does not make. checkAllowedDuration narrows it.
  student: { id: string; full_name: string; photo_url: string | null; allowed_durations: unknown } | null
  // The report paired with this lesson, embedded by the GET route. reports.lesson_id
  // is UNIQUE, so PostgREST reads it as a to-one relationship and sends an object -
  // but the array shape is typed here too, because the flatten below is the project
  // rule for every Supabase nested join and must accept both. Absent (older cached
  // response), null (no row, or RLS filtered it) and [] all mean "no report".
  reports?: LessonReport | LessonReport[] | null
}

interface LessonReport {
  id: string
  status: string
}

interface Props {
  teachers: Teacher[]
  // The range the list OPENS on, resolved server-side in the admin's own timezone.
  // Two different things arrive here: ?filter=today seeds that single day, and every
  // other landing seeds month-to-date - the 1st of the current month through today.
  // '' means "no date filter", which is what a profile with no timezone gets.
  initialDateFrom?: string
  initialDateTo?: string
  // The LANDING default, which Clear returns to. A separate pair because it and the
  // two above DISAGREE under ?filter=today: that deep link opens on one day, but Clear
  // must hand back the month-to-date view rather than the deep link's range. Equal to
  // initialDateFrom/To on every other landing, and '' on a timezone-less profile,
  // which keeps Clear emptying the inputs there exactly as it always did.
  defaultDateFrom?: string
  defaultDateTo?: string
  // Admin's profile timezone; null when unset. Date & Time column renders
  // in this zone so it agrees with the GET route's date-filter bucketing.
  adminTz: string | null
  // True when the URL carried a filter/deep-link param. The URL then wins outright:
  // no restore from sessionStorage, and storage is overwritten from what the URL
  // produced. Presence of the param is the test, not the range it produced - an
  // unrecognised ?filter= value lands on the month-to-date default and a timezone-less
  // profile lands on no date filter at all, and either way that IS the URL's answer.
  // With the date range no longer in the stored record, what this suppresses is the
  // remembered TEACHER and STATUS: a deep link gets the clean default list.
  hasUrlFilters?: boolean
}

// The Status dropdown's options, and with them the set of status values this page is
// willing to restore. One list rather than two: a value read back out of storage is
// accepted only if it is still something the dropdown can display.
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-Show' },
  { value: 'missed', label: 'Missed (no report)' },
]

// Page-scoped, so the sibling admin lists can each keep their own record later.
const FILTERS_STORAGE_KEY = 'll-admin-classes-filters'

/**
 * What this page remembers for the rest of the browsing session.
 *
 * NOT the search text and NOT the page number, both deliberate: a remembered search
 * term reads as a broken list ("where did my classes go?") on a page you did not type
 * it on, and a remembered page 7 is meaningless against a result set that has moved on.
 *
 * AND NOT THE DATE RANGE, which is the landing default's business rather than the
 * session's: every landing opens on month-to-date, computed from the clock at request
 * time by the server page, so a remembered range could add nothing except the chance
 * of disagreeing with it. It also retires the staleness this record used to work
 * around - a stored range cannot go stale if there is no stored range.
 *
 * Records written BEFORE dates left this key still carry preset/from/to.
 * parseStoredFilters below reads teacher and status out of them and ignores the rest
 * rather than rejecting the record, so an admin mid-session keeps the selection they
 * had. That is also why the storage key is deliberately unchanged: there is no
 * incompatible shape to fence off, only three fields nothing reads any more.
 */
interface StoredFilters {
  teacher: string
  status: string
}

const DEFAULT_STORED_FILTERS: StoredFilters = {
  teacher: '',
  status: '',
}

// Flattens the embedded report to a single row or null. Array.isArray() first, per
// the locked rule for Supabase nested joins: the shape depends on how PostgREST reads
// the relationship, and neither side of this wire is validated. An empty array is the
// same answer as a missing one - no report.
function flattenReport(reports: Lesson['reports']): LessonReport | null {
  if (!reports) return null
  if (Array.isArray(reports)) return reports[0] ?? null
  return reports
}

// Maps raw DB status values to a display label and colour
function getStatusMeta(status: string): { label: string; bg: string; color: string } {
  switch (status) {
    case 'scheduled':
      return { label: 'Upcoming', bg: '#EFF6FF', color: '#1D4ED8' }
    case 'completed':
      return { label: 'Completed', bg: '#F0FDF4', color: '#15803D' }
    case 'cancelled':
      return { label: 'Cancelled', bg: '#FEF2F2', color: '#B91C1C' }
    case 'cancelled_by_student':
      return { label: 'Cancelled by student', bg: '#FEF2F2', color: '#B91C1C' }
    case 'cancelled_by_teacher':
      return { label: 'Cancelled by teacher', bg: '#FEF2F2', color: '#B91C1C' }
    case 'student_no_show':
      return { label: 'Student No-Show', bg: '#FFF7ED', color: '#C2410C' }
    case 'teacher_no_show':
      return { label: 'Teacher No-Show', bg: '#FEF2F2', color: '#B91C1C' }
    // The class happened but the teacher blew the 12h report window, so pay is
    // forfeited. A real, live status - without this case it fell through to
    // `default` and rendered the raw lowercase string.
    case 'missed':
      return { label: 'Missed - no report', bg: '#FEF9C3', color: '#A16207' }
    default:
      return { label: status, bg: '#F3F4F6', color: '#374151' }
  }
}

// The status cell renders as two pills: a short OUTCOME ("Cancelled" / "Rescheduled")
// carrying the colour, and a quiet grey ACTOR ("by student"). getCancellationLabel is
// deliberately NOT changed - it is shared by eight call sites across all three portals
// and its combined string is correct everywhere else. This splits the same two inputs
// locally, for this table only, so the pills never wrap and every row is one line high.
//
// Mirrors getCancellationLabel's own resolution order exactly: reschedule wins over
// cancellation, cancelled_by wins over the status suffix, and an unattributed legacy row
// yields no actor rather than an invented one.
function getOutcomeParts(lesson: Lesson): { outcome: string; actor: string | null } | null {
  const label = getCancellationLabel(lesson, 'admin')
  if (label === null) return null

  const isReschedule = lesson.rescheduled_by === 'student' || lesson.rescheduled_by === 'admin'
  const outcome = isReschedule ? 'Rescheduled' : 'Cancelled'

  let actor: string | null
  if (isReschedule) {
    actor = lesson.rescheduled_by as string
  } else if (lesson.cancelled_by === 'student' || lesson.cancelled_by === 'teacher' || lesson.cancelled_by === 'admin') {
    actor = lesson.cancelled_by
  } else if (lesson.status === 'cancelled_by_student') {
    actor = 'student'
  } else if (lesson.status === 'cancelled_by_teacher') {
    actor = 'teacher'
  } else {
    actor = null
  }

  return { outcome, actor }
}

// Read-only marker for a SCHEDULED lesson whose duration is not one this student is
// allowed to book. Returns null when nothing should render. Same {label, bg, color}
// shape getStatusMeta returns, because every pill in this file is styled from a plain
// object with inline styles.
//
// INFORMATIONAL. Admin booking is deliberately exempt from the per-student duration
// rule, so a marked row is not an error and nothing here blocks or writes.
//
// Two deliberate non-behaviours:
//  - 'unknown' RENDERS (as "?"). It means the allowed list could not be read, which
//    must never look the same as "this duration is fine". See checkAllowedDuration.
//  - No clock is read. Status alone decides, so this is render-pure and identical on
//    server and client; a past-but-still-'scheduled' row keeps its marker, which is
//    correct - the row still claims the class is going ahead.
function getDurationMarker(
  status: string,
  durationMinutes: number,
  allowed: unknown
): { char: string; bg: string; color: string; label: string } | null {
  if (status !== 'scheduled') return null

  const result = checkAllowedDuration(allowed, durationMinutes)
  if (result.state === 'ok') return null

  if (result.state === 'not_allowed') {
    return {
      char: '!',
      bg: '#FFF8E8',
      color: '#B45309',
      label: `${durationMinutes} min is not in this student's allowed durations (${result.durations.join(', ')})`,
    }
  }

  return {
    char: '?',
    bg: '#f3f4f6',
    color: '#6b7280',
    label: "This student's allowed durations could not be read",
  }
}

// Browser-local fallback, used only when the admin profile has no timezone
// (matches the GET route's own null-tz fail-safe).
function formatDateTime(isoString: string): string {
  const d = new Date(isoString)
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const year = d.getFullYear()
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${mins}`
}

export default function ClassesListClient({ teachers, initialDateFrom = '', initialDateTo = '', defaultDateFrom = '', defaultDateTo = '', adminTz, hasUrlFilters = false }: Props) {
  const router = useRouter()

  const [lessons, setLessons] = useState<Lesson[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // Filter state
  const [search, setSearch] = useState('')
  const [filterTeacher, setFilterTeacher] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState(initialDateFrom)
  const [filterDateTo, setFilterDateTo] = useState(initialDateTo)

  // Only the search-driven fetch is debounced. `search` stays a controlled input so
  // the field updates on every keystroke; the request keys off `debouncedSearch`,
  // which settles 300ms after the last keystroke. The other filters are not
  // debounced — they feed fetchLessons directly and fire immediately.
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const pageSize = 50

  // Cleanup cancels the pending timer on the next keystroke and on unmount.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  // The record handed to sessionStorage, rebuilt only when a PERSISTED filter moves.
  // `search`, `page` and both dates are absent from the deps on purpose: none of them
  // is stored, so none of them should cost a rebuild or a write.
  const persistedFilters = useMemo<StoredFilters>(() => ({
    teacher: filterTeacher,
    status: filterStatus,
  }), [filterTeacher, filterStatus])

  /**
   * Shape validation for a decoded stored record. Null rejects the whole record and
   * the page opens on defaults.
   *
   * STRUCTURAL problems reject everything: not an object, or a field of the wrong
   * type - a record written by a different version of this page, or edited by hand,
   * cannot be trusted field by field.
   *
   * DATA DRIFT does not: a teacher who has since left, or a status the dropdown no
   * longer offers, is a well-formed record whose target has moved. Those single fields
   * fall back to "all". Left as-is, a teacher id absent from the dropdown would filter
   * the list by an invisible selection - the select would render blank while the fetch
   * quietly narrowed the results.
   *
   * OLD-SHAPE RECORDS PARSE. A record still carrying preset/from/to from before the
   * date range left this key is read for teacher and status and nothing else: the
   * extra fields are not inspected, not validated, and never a reason to reject. The
   * next write replaces it with the current shape, so the migration costs nothing.
   */
  function parseStoredFilters(raw: unknown): StoredFilters | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>

    const teacher = record.teacher
    const status = record.status
    if (typeof teacher !== 'string' || typeof status !== 'string') return null

    return {
      teacher: teachers.some((t) => t.id === teacher) ? teacher : '',
      status: STATUS_OPTIONS.some((o) => o.value === status) ? status : '',
    }
  }

  /**
   * Push a restored record into filter state. Runs once, from the hook's mount effect.
   *
   * Teacher and status ONLY. The two date inputs are deliberately not touched, and
   * that is the whole point of taking dates out of the record: the month-to-date range
   * the server page seeded survives the restore instead of being overwritten a frame
   * later by a range from an earlier visit. `page` is untouched too - a restore only
   * ever happens on mount, where it is already 1.
   */
  function applyStoredFilters(stored: StoredFilters) {
    setFilterTeacher(stored.teacher)
    setFilterStatus(stored.status)
  }

  const { clear: clearStoredFilters } = useFilterPersistence<StoredFilters>({
    storageKey: FILTERS_STORAGE_KEY,
    value: persistedFilters,
    defaultValue: DEFAULT_STORED_FILTERS,
    skipRestore: hasUrlFilters,
    parse: parseStoredFilters,
    apply: applyStoredFilters,
  })

  // Monotonic request token. Filter controls stay enabled during a fetch, so a
  // newer request can start while an older one is in flight — without this, a slow
  // earlier response would overwrite the newer rows, and a late-FAILING stale
  // request (the Clear case) would blank the list and raise the error banner over
  // fresher results. It also covers the restore: the default-filter request fired on
  // mount is superseded by the restored-filter one a frame later.
  const lessonsRequestIdRef = useRef(0)

  const fetchLessons = useCallback(async (currentPage: number) => {
    // Claim the newest request; every post-await write below re-checks this id.
    const requestId = ++lessonsRequestIdRef.current
    setLoading(true)
    setLoadError(false)
    const params = new URLSearchParams()
    params.set('page', currentPage.toString())
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (filterTeacher) params.set('teacher_id', filterTeacher)
    if (filterStatus) params.set('status', filterStatus)
    if (filterDateFrom) params.set('date_from', filterDateFrom)
    if (filterDateTo) params.set('date_to', filterDateTo)

    try {
      const res = await fetch(`/api/admin/classes?${params.toString()}`)
      if (requestId !== lessonsRequestIdRef.current) return
      if (!res.ok) throw new Error('Failed to load classes')
      // Body parse is a second await — re-check before any write.
      const data = await res.json()
      if (requestId !== lessonsRequestIdRef.current) return
      setLessons(data.lessons ?? [])
      setTotal(data.total ?? 0)
    } catch {
      if (requestId !== lessonsRequestIdRef.current) return
      setLessons([])
      setTotal(0)
      setLoadError(true)
    } finally {
      // A superseded request must never turn the spinner off — the newest request
      // owns the loading state until its own response lands.
      if (requestId === lessonsRequestIdRef.current) setLoading(false)
    }
  }, [debouncedSearch, filterTeacher, filterStatus, filterDateFrom, filterDateTo])

  // Single fetch driver: fetchLessons is memoised on the filter values, so any
  // filter or page change re-runs this effect exactly once. Nothing else calls
  // fetchLessons except the applyFilters no-op corner below.
  useEffect(() => {
    fetchLessons(page)
  }, [fetchLessons, page])

  // Reset to page 1 when filters change
  function applyFilters() {
    // Apply must not race the search debounce, so flush the typed term now. The
    // still-pending timer will later set this same value, which React bails out
    // of — no extra render, no second request.
    const searchChanged = debouncedSearch !== search
    const pageChanged = page !== 1
    if (searchChanged) setDebouncedSearch(search)
    if (pageChanged) setPage(1)
    // Both updates batch into one render, so the effect above fires once. If
    // neither changed there is no state change to drive it, so refetch directly
    // (token-guarded like every other call).
    if (!searchChanged && !pageChanged) fetchLessons(1)
  }

  function clearFilters() {
    setSearch('')
    // Flush the debounced term in the same batch, otherwise the pending timer
    // would land 300ms later and fire a second request.
    setDebouncedSearch('')
    setFilterTeacher('')
    setFilterStatus('')
    // Back to the range the page LANDED on, not to no range at all. Clear means "as I
    // landed", and landing here means month-to-date; an admin who genuinely wants all
    // time can still empty the two date inputs by hand. Both props are '' on a
    // timezone-less profile, so Clear blanks them there exactly as it always did - and
    // under ?filter=today this deliberately returns month-to-date rather than the deep
    // link's single day, which is why the default arrives as its own prop pair.
    setFilterDateFrom(defaultDateFrom)
    setFilterDateTo(defaultDateTo)
    setPage(1)
    // Clear the remembered record too, immediately — "Clear" has to mean cleared for
    // the next visit as well, including when the filters were already at their
    // defaults and no state change would reach the persistence effect.
    clearStoredFilters()
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div style={{ padding: '32px' }}>

      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: 0 }}>Classes</h1>
          <p style={{ fontSize: '14px', color: '#6B7280', marginTop: '4px' }}>
            {loadError ? '—' : `${total} ${total === 1 ? 'class' : 'classes'} found`}
          </p>
        </div>
        <Link href="/admin/classes/new" prefetch={false}>
          <button
            style={{
              backgroundColor: '#FF8303',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Book a Class
          </button>
        </Link>
      </div>

      {/* Filters row */}
      <div className="card-elevated" style={{
        padding: '16px',
        marginBottom: '20px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        alignItems: 'flex-end',
      }}>

        {/* Search */}
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
            Search
          </label>
          <input
            type="text"
            placeholder="Teacher or student name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            style={{
              width: '100%',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '14px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Teacher filter */}
        <div style={{ flex: '1 1 160px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
            Teacher
          </label>
          <select
            value={filterTeacher}
            onChange={(e) => setFilterTeacher(e.target.value)}
            style={{
              width: '100%',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '14px',
              outline: 'none',
              backgroundColor: 'white',
              boxSizing: 'border-box',
            }}
          >
            <option value="">All teachers</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name}</option>
            ))}
          </select>
        </div>

        {/* Status filter */}
        <div style={{ flex: '1 1 160px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
            Status
          </label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{
              width: '100%',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '14px',
              outline: 'none',
              backgroundColor: 'white',
              boxSizing: 'border-box',
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Date range. From/To plus the timezone-correct quick-range presets;
            a preset reports both halves in one onChange, so one click is one fetch. */}
        <DateRangeFilter
          from={filterDateFrom}
          to={filterDateTo}
          onChange={(f, t) => {
            setFilterDateFrom(f)
            setFilterDateTo(t)
            // A preset applied while on a later page must not send that page number against the new range.
            setPage(1)
          }}
          tz={adminTz}
        />

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={applyFilters}
            disabled={loading}
            style={{
              backgroundColor: '#FFF0E0',
              color: '#FF8303',
              border: '1px solid #FF8303',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading…' : 'Apply'}
          </button>
          <button
            onClick={clearFilters}
            style={{
              backgroundColor: 'white',
              color: '#374151',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="card-elevated" style={{
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 150px 95px 200px 150px 70px',
          padding: '12px 16px',
          backgroundColor: '#F9FAFB',
          borderBottom: '1px solid #E5E7EB',
          fontSize: '12px',
          fontWeight: 700,
          color: '#6B7280',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          <span>Teacher</span>
          <span>Student</span>
          <span>Date &amp; Time</span>
          <span>Duration</span>
          <span style={{ textAlign: 'center' }}>Status</span>
          {/* Always rendered, not gated on the Cancelled filter: the admin should see
              when a class was cancelled without having to filter for it first. Replaces
              the old Reason column, which echoed the status pill on every row - students
              are never asked for a cancellation reason, so nothing ever writes one. */}
          <span style={{ textAlign: 'center' }}>Cancelled at</span>
          <span>Report</span>
        </div>

        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
            Loading classes...
          </div>
        ) : loadError ? (
          <div style={{ padding: '48px', textAlign: 'center', borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6', color: '#FD5602', fontSize: '14px' }}>
            Couldn&apos;t load classes. This is not an empty result — try refreshing.
          </div>
        ) : lessons.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
            No classes found for the selected filters.
          </div>
        ) : (
          lessons.map((lesson, index) => {
            const statusMeta = getStatusMeta(lesson.status)
            const outcomeParts = getOutcomeParts(lesson)
            // A missing student join gives `undefined` here, which resolves to the
            // 'unknown' marker rather than to no marker: we genuinely could not read
            // the list, and that is what the row should say.
            const durationMarker = getDurationMarker(
              lesson.status,
              lesson.duration_minutes,
              lesson.student?.allowed_durations
            )
            const report = flattenReport(lesson.reports)
            return (
              <div
                key={lesson.id}
                onClick={() => router.push(`/admin/classes/${lesson.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 150px 95px 200px 150px 70px',
                  padding: '14px 16px',
                  borderBottom: index < lessons.length - 1 ? '1px solid #F3F4F6' : 'none',
                  cursor: 'pointer',
                  alignItems: 'center',
                  transition: 'background-color 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#F9FAFB')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                {/* Teacher */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: '#F3F4F6',
                    overflow: 'hidden',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#6B7280',
                  }}>
                    {lesson.teacher?.photo_url ? (
                      <img src={lesson.teacher.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      lesson.teacher?.full_name?.[0] ?? '?'
                    )}
                  </div>
                  <span style={{ fontSize: '14px', color: '#111827', fontWeight: 500 }}>
                    {lesson.teacher?.full_name ?? '—'}
                  </span>
                </div>

                {/* Student */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: '#F3F4F6',
                    overflow: 'hidden',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#6B7280',
                  }}>
                    {lesson.student?.photo_url ? (
                      <img src={lesson.student.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      lesson.student?.full_name?.[0] ?? '?'
                    )}
                  </div>
                  <span style={{ fontSize: '14px', color: '#111827', fontWeight: 500 }}>
                    {lesson.student?.full_name ?? '—'}
                  </span>
                </div>

                {/* Date & time */}
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  {adminTz ? formatInstantInTz(lesson.scheduled_at, adminTz) : formatDateTime(lesson.scheduled_at)}
                </span>

                {/* Duration. The marker is NESTED inside this span, never a sibling:
                    the row is a CSS grid and every direct child is a grid item, so a
                    sibling would silently consume the next column. No grid template
                    changes, and none needed - Duration is a cell in both variants. */}
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  {lesson.duration_minutes} min
                  {durationMarker && (
                    <span
                      title={durationMarker.label}
                      aria-label={durationMarker.label}
                      style={{
                        display: 'inline-block',
                        marginLeft: '6px',
                        padding: '1px 7px',
                        borderRadius: '20px',
                        fontSize: '12px',
                        fontWeight: 600,
                        backgroundColor: durationMarker.bg,
                        color: durationMarker.color,
                      }}
                    >
                      {durationMarker.char}
                    </span>
                  )}
                </span>

                {/* Two pills, never stacked and never wrapping: the outcome carries the
                    colour, the actor is quiet grey beside it. The wrapper is one grid
                    child - the row is a CSS grid and a second sibling would silently
                    consume the next column. Same trap the duration marker documents. */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'nowrap' }}>
                  <span style={{
                    // Fixed width so the grey actor pill beside it starts at the same x
                    // on every row. Without it, "Cancelled" and "Rescheduled" are
                    // different widths and the actor pills stagger down the column.
                    // 104px fits "Rescheduled", the widest label this cell renders.
                    minWidth: '104px',
                    textAlign: 'center',
                    padding: '3px 10px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: 600,
                    backgroundColor: statusMeta.bg,
                    color: statusMeta.color,
                    whiteSpace: 'nowrap',
                    boxSizing: 'border-box',
                  }}>
                    {outcomeParts ? outcomeParts.outcome : statusMeta.label}
                  </span>
                  {outcomeParts?.actor && (
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '20px',
                      fontSize: '11px',
                      backgroundColor: '#F3F4F6',
                      color: '#4B5563',
                      whiteSpace: 'nowrap',
                    }}>
                      by {outcomeParts.actor}
                    </span>
                  )}
                </div>

                {/* Same adminTz ternary and the same two formatters the Date & Time cell
                    uses, so this stamp and the class time can never render in different
                    zones. A row that was never cancelled gets an em dash, not a blank. */}
                <span style={{ fontSize: '12px', color: '#374151', whiteSpace: 'nowrap', textAlign: 'center' }}>
                  {lesson.cancelled_at
                    ? (adminTz ? formatInstantInTz(lesson.cancelled_at, adminTz) : formatDateTime(lesson.cancelled_at))
                    : <span style={{ color: '#D1D5DB' }}>&mdash;</span>}
                </span>

                {/* Report link — stop propagation so clicking it doesn't open class detail.
                    Points at the report's own detail page. The old ?lesson_id= form went to
                    the reports LIST, which ignores that param, so every click landed on an
                    unfiltered list; the id is on the row now, so link straight at it. With no
                    report row there is nothing to open, so the cell shows a muted placeholder
                    rather than a link that resolves to the wrong page. */}
                <div onClick={(e) => e.stopPropagation()}>
                  {report ? (
                    <Link
                      href={`/admin/reports/${report.id}`}
                      prefetch={false}
                      style={{ fontSize: '13px', color: '#FF8303', textDecoration: 'none', fontWeight: 500 }}
                    >
                      View
                    </Link>
                  ) : (
                    <span style={{ fontSize: '13px', color: '#9CA3AF' }}>—</span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '24px' }}>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
            style={{
              padding: '8px 16px',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              backgroundColor: 'white',
              fontSize: '14px',
              cursor: page === 1 || loading ? 'not-allowed' : 'pointer',
              color: page === 1 || loading ? '#9CA3AF' : '#374151',
            }}
          >
            Previous
          </button>
          <span style={{ padding: '8px 12px', fontSize: '14px', color: '#374151' }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || loading}
            style={{
              padding: '8px 16px',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              backgroundColor: 'white',
              fontSize: '14px',
              cursor: page === totalPages || loading ? 'not-allowed' : 'pointer',
              color: page === totalPages || loading ? '#9CA3AF' : '#374151',
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
