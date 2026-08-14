'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { checkAllowedDuration } from '@/lib/lessons/allowedDurations'
import { formatInstantInTz } from '@/lib/exportTime'

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
}

interface Props {
  teachers: Teacher[]
  // Seeded from ?filter=today by the server page (admin's own timezone); '' means
  // "no date filter".
  initialDateFrom?: string
  initialDateTo?: string
  // Admin's profile timezone; null when unset. Date & Time column renders
  // in this zone so it agrees with the GET route's date-filter bucketing.
  adminTz: string | null
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
    case 'flagged':
      return { label: 'Flagged', bg: '#FEF9C3', color: '#A16207' }
    default:
      return { label: status, bg: '#F3F4F6', color: '#374151' }
  }
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

export default function ClassesListClient({ teachers, initialDateFrom = '', initialDateTo = '', adminTz }: Props) {
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

  // Monotonic request token. Filter controls stay enabled during a fetch, so a
  // newer request can start while an older one is in flight — without this, a slow
  // earlier response would overwrite the newer rows, and a late-FAILING stale
  // request (the Clear case) would blank the list and raise the error banner over
  // fresher results.
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
    setFilterDateFrom('')
    setFilterDateTo('')
    setPage(1)
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
            <option value="">All statuses</option>
            <option value="upcoming">Upcoming</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no_show">No-Show</option>
            <option value="flagged">Flagged</option>
          </select>
        </div>

        {/* Date from */}
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
            From
          </label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
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

        {/* Date to */}
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
            To
          </label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
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
          gridTemplateColumns: filterStatus === 'cancelled' ? '1fr 1fr 160px 80px 110px 1fr 80px' : '1fr 1fr 160px 80px 110px 80px',
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
          <span>Status</span>
          {filterStatus === 'cancelled' && (
            <span>Reason</span>
          )}
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
            const statusLabel = getCancellationLabel(lesson, 'admin') ?? statusMeta.label
            // A missing student join gives `undefined` here, which resolves to the
            // 'unknown' marker rather than to no marker: we genuinely could not read
            // the list, and that is what the row should say.
            const durationMarker = getDurationMarker(
              lesson.status,
              lesson.duration_minutes,
              lesson.student?.allowed_durations
            )
            return (
              <div
                key={lesson.id}
                onClick={() => router.push(`/admin/classes/${lesson.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: filterStatus === 'cancelled' ? '1fr 1fr 160px 80px 110px 1fr 80px' : '1fr 1fr 160px 80px 110px 80px',
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

                {/* Status tag */}
                <span style={{
                  display: 'inline-block',
                  padding: '3px 10px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: statusMeta.bg,
                  color: statusMeta.color,
                  width: 'fit-content',
                }}>
                  {statusLabel}
                </span>

                {filterStatus === 'cancelled' && (
                  <div onClick={(e) => e.stopPropagation()} style={{ fontSize: '13px', color: '#6B7280' }}>
                    {lesson.cancellation_reason ?? <span style={{ color: '#D1D5DB', fontStyle: 'italic' }}>No reason provided</span>}
                  </div>
                )}

                {/* Report link — stop propagation so clicking it doesn't open class detail */}
                <div onClick={(e) => e.stopPropagation()}>
                  <Link
                    href={`/admin/reports?lesson_id=${lesson.id}`}
                    prefetch={false}
                    style={{ fontSize: '13px', color: '#FF8303', textDecoration: 'none', fontWeight: 500 }}
                  >
                    View
                  </Link>
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
