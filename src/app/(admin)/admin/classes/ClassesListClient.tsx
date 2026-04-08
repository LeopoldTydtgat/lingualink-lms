'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
  teams_join_url: string | null
  teacher_id: string
  student_id: string
  teacher: { id: string; full_name: string; photo_url: string | null } | null
  student: { id: string; full_name: string; photo_url: string | null } | null
}

interface Props {
  teachers: Teacher[]
}

// Maps raw DB status values to a display label and colour
function getStatusMeta(status: string): { label: string; bg: string; color: string } {
  switch (status) {
    case 'scheduled':
      return { label: 'Upcoming', bg: '#EFF6FF', color: '#1D4ED8' }
    case 'completed':
      return { label: 'Completed', bg: '#F0FDF4', color: '#15803D' }
    case 'cancelled':
    case 'cancelled_by_student':
    case 'cancelled_by_teacher':
      return { label: 'Cancelled', bg: '#FEF2F2', color: '#B91C1C' }
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

function formatDateTime(isoString: string): string {
  const d = new Date(isoString)
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const year = d.getFullYear()
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${mins}`
}

export default function ClassesListClient({ teachers }: Props) {
  const router = useRouter()

  const [lessons, setLessons] = useState<Lesson[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Filter state
  const [search, setSearch] = useState('')
  const [filterTeacher, setFilterTeacher] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  const pageSize = 50

  const fetchLessons = useCallback(async (currentPage: number) => {
    setLoading(true)
    const params = new URLSearchParams()
    params.set('page', currentPage.toString())
    if (search) params.set('search', search)
    if (filterTeacher) params.set('teacher_id', filterTeacher)
    if (filterStatus) params.set('status', filterStatus)
    if (filterDateFrom) params.set('date_from', filterDateFrom)
    if (filterDateTo) params.set('date_to', filterDateTo)

    const res = await fetch(`/api/admin/classes?${params.toString()}`)
    const data = await res.json()
    setLessons(data.lessons ?? [])
    setTotal(data.total ?? 0)
    setLoading(false)
  }, [search, filterTeacher, filterStatus, filterDateFrom, filterDateTo])

  // Refetch when filters or page change
  useEffect(() => {
    fetchLessons(page)
  }, [fetchLessons, page])

  // Reset to page 1 when filters change
  function applyFilters() {
    setPage(1)
    fetchLessons(1)
  }

  function clearFilters() {
    setSearch('')
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: 0 }}>Classes</h1>
          <p style={{ fontSize: '14px', color: '#6B7280', marginTop: '4px' }}>
            {total} {total === 1 ? 'class' : 'classes'} found
          </p>
        </div>
        <Link href="/admin/classes/new">
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
      <div style={{
        backgroundColor: 'white',
        border: '1px solid #E5E7EB',
        borderRadius: '10px',
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
            style={{
              backgroundColor: '#FF8303',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Apply
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
      <div style={{
        backgroundColor: 'white',
        border: '1px solid #E5E7EB',
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 160px 80px 110px 80px',
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
          <span>Report</span>
        </div>

        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
            Loading classes...
          </div>
        ) : lessons.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
            No classes found for the selected filters.
          </div>
        ) : (
          lessons.map((lesson, index) => {
            const statusMeta = getStatusMeta(lesson.status)
            return (
              <div
                key={lesson.id}
                onClick={() => router.push(`/admin/classes/${lesson.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 160px 80px 110px 80px',
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
                  {formatDateTime(lesson.scheduled_at)}
                </span>

                {/* Duration */}
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  {lesson.duration_minutes} min
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
                  {statusMeta.label}
                </span>

                {/* Report link — stop propagation so clicking it doesn't open class detail */}
                <div onClick={(e) => e.stopPropagation()}>
                  <Link
                    href={`/admin/reports?lesson_id=${lesson.id}`}
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
            disabled={page === 1}
            style={{
              padding: '8px 16px',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              backgroundColor: 'white',
              fontSize: '14px',
              cursor: page === 1 ? 'not-allowed' : 'pointer',
              color: page === 1 ? '#9CA3AF' : '#374151',
            }}
          >
            Previous
          </button>
          <span style={{ padding: '8px 12px', fontSize: '14px', color: '#374151' }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{
              padding: '8px 16px',
              border: '1px solid #D1D5DB',
              borderRadius: '6px',
              backgroundColor: 'white',
              fontSize: '14px',
              cursor: page === totalPages ? 'not-allowed' : 'pointer',
              color: page === totalPages ? '#9CA3AF' : '#374151',
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
