'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { EmailBounceBadge } from '@/components/EmailBounceBadge'

type Teacher = {
  id: string
  full_name: string
}

type Student = {
  id: string
  full_name: string | null
  email: string
  photo_url: string | null
  status: string | null
  is_private: boolean
  company_id: string | null
  company_name: string | null
  email_bounced_at: string | null
  email_bounce_reason: string | null
  hours_remaining: number | null
  teachers: Teacher[]
}

type Props = {
  students: Student[]
  // Seeded from ?filter=low_hours by the server page.
  initialLowHoursOnly?: boolean
}

const STATUS_OPTIONS = ['All', 'current', 'former', 'on_hold']

const STATUS_LABEL: Record<string, string> = {
  current: 'Current',
  former: 'Former',
  on_hold: 'On Hold',
}

const LOW_HOURS_THRESHOLD = 2

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'current' || status === null) return null

  const colour =
    status === 'former'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'on_hold'
      ? { backgroundColor: '#FFF8E8', color: '#B45309' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={colour}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function HoursDisplay({ hours }: { hours: number | null }) {
  if (hours === null) {
    return <span style={{ color: '#9ca3af' }}>—</span>
  }

  const formatted = hours % 1 === 0 ? hours : hours.toFixed(1)
  const isLow = hours < LOW_HOURS_THRESHOLD

  if (isLow) {
    return (
      <span className="font-medium" style={{ color: '#FD5602' }}>
        {formatted}h left
      </span>
    )
  }

  return <span style={{ color: '#4b5563' }}>{formatted}h</span>
}

export default function StudentsListClient({ students, initialLowHoursOnly = false }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [typeFilter, setTypeFilter] = useState('All') // All / Private / B2B
  const [lowHoursOnly, setLowHoursOnly] = useState(initialLowHoursOnly)
  const [showArchived, setShowArchived] = useState(false)

  const filtered = students.filter((s) => {
    const matchesSearch =
      (s.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase())

    const matchesStatus =
      statusFilter === 'All' || s.status === statusFilter

    const matchesType =
      typeFilter === 'All' ||
      (typeFilter === 'Private' && s.is_private) ||
      (typeFilter === 'B2B' && !s.is_private)

    const matchesLowHours =
      !lowHoursOnly ||
      (s.hours_remaining !== null && s.hours_remaining < LOW_HOURS_THRESHOLD)

    const matchesArchived = showArchived || s.status !== 'former'

    return matchesSearch && matchesStatus && matchesType && matchesLowHours && matchesArchived
  })

  const lowHoursCount = students.filter(
    (s) => s.hours_remaining !== null && s.hours_remaining < LOW_HOURS_THRESHOLD
  ).length

  return (
    <div className="p-6">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Students</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {students.length} student{students.length !== 1 ? 's' : ''} total
            {lowHoursCount > 0 && (
              <span className="ml-2 text-red-600 font-medium">
                · {lowHoursCount} low on hours
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => router.push('/admin/students/new')}
          className="btn-primary-hover px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#FF8303' }}
        >
          + Add Student
        </button>
      </div>

      {/* Search and filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 'All' ? 'All Statuses' : STATUS_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
        >
          <option value="All">All Types</option>
          <option value="Private">Private</option>
          <option value="B2B">B2B</option>
        </select>
        {/* Low hours quick filter */}
        <button
          onClick={() => setLowHoursOnly(!lowHoursOnly)}
          className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors"
          style={
            lowHoursOnly
              ? { backgroundColor: '#fee2e2', borderColor: '#fca5a5', color: '#991b1b' }
              : { backgroundColor: '#ffffff', borderColor: '#e5e7eb', color: '#6b7280' }
          }
        >
          Low Hours
        </button>
        {/* Show archived toggle */}
        <button
          onClick={() => setShowArchived(!showArchived)}
          className="px-3 py-2 rounded-lg text-sm font-medium border"
          style={
            showArchived
              ? { backgroundColor: '#FF8303', color: '#ffffff', borderColor: '#FF8303' }
              : { backgroundColor: '#ffffff', color: '#6b7280', borderColor: '#e5e7eb' }
          }
        >
          Show Archived
        </button>
      </div>

      {/* List */}
      <div className="card-elevated overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-10" style={{ color: '#9ca3af' }}>
            No students found.
          </div>
        ) : (
          <div>
            {filtered.map((student, index) => {
              const lineTwoParts: string[] = [student.email]
              if (student.company_name) lineTwoParts.push(student.company_name)
              if (student.teachers.length > 0) {
                lineTwoParts.push(student.teachers.map((t) => t.full_name).join(', '))
              }

              return (
                <Link
                  key={student.id}
                  href={`/admin/students/${student.id}`}
                  prefetch={false}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                  style={
                    index !== filtered.length - 1
                      ? { borderBottom: '1px solid #E0DFDC' }
                      : undefined
                  }
                >
                  {student.photo_url ? (
                    <img
                      src={student.photo_url}
                      alt={student.full_name ?? ''}
                      className="h-9 w-9 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div
                      className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                      style={{ backgroundColor: '#FF8303' }}
                    >
                      {(student.full_name ?? '?').charAt(0).toUpperCase()}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {student.full_name ? (
                        <span className="font-medium text-gray-900">{student.full_name}</span>
                      ) : (
                        <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No name set</span>
                      )}
                      <StatusBadge status={student.status} />
                      {student.email_bounced_at ? <EmailBounceBadge /> : null}
                    </div>
                    <div className="text-sm truncate" style={{ color: '#4b5563' }}>
                      {lineTwoParts.join(' · ')}
                    </div>
                  </div>

                  <div className="flex-shrink-0 text-sm text-right">
                    <HoursDisplay hours={student.hours_remaining} />
                  </div>

                  <ChevronRight size={16} style={{ color: '#9ca3af' }} />
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
