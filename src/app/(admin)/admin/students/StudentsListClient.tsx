'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
  // True when the server-side read failed. An empty table would read as
  // "no students", so the list renders an error state instead.
  loadError?: boolean
}

type TabId = 'all' | 'low_hours' | 'on_hold' | 'archived'

const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All Students' },
  { id: 'low_hours', label: 'Low Hours' },
  { id: 'on_hold', label: 'On Hold' },
  { id: 'archived', label: 'Archived' },
]

const STATUS_LABEL: Record<string, string> = {
  current: 'Current',
  former: 'Former',
  on_hold: 'On Hold',
}

const LOW_HOURS_THRESHOLD = 2

// Single implementation shared by the list filter and the tab counts, so a tab's
// number can never disagree with the rows that tab shows.
function matchesTab(s: Student, tab: TabId): boolean {
  if (tab === 'archived') return s.status === 'former'
  if (tab === 'on_hold') return s.status === 'on_hold'
  if (tab === 'low_hours') {
    return (
      s.status !== 'former' &&
      s.hours_remaining !== null &&
      s.hours_remaining < LOW_HOURS_THRESHOLD
    )
  }
  // 'all' is deliberately "not former" rather than "is current", so a row with a
  // null or unrecognised status is still visible somewhere.
  return s.status !== 'former'
}

function matchesTypeFilter(s: Student, typeFilter: string): boolean {
  return (
    typeFilter === 'All' ||
    (typeFilter === 'Private' && s.is_private) ||
    (typeFilter === 'B2B' && !s.is_private)
  )
}

function StatusBadge({ status }: { status: string | null }) {
  const colour =
    status === 'current'
      ? { backgroundColor: '#DCFCE7', color: '#15803D' }
      : status === 'former'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'on_hold'
      ? { backgroundColor: '#FFF8E8', color: '#B45309' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={colour}
    >
      {STATUS_LABEL[status ?? ''] ?? status ?? '—'}
    </span>
  )
}

function HoursBadge({ hours }: { hours: number | null }) {
  if (hours === null) {
    return <span className="text-gray-400 text-sm">—</span>
  }

  const isLow = hours < LOW_HOURS_THRESHOLD

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={
        isLow
          ? { backgroundColor: '#FFEEE6', color: '#FD5602' }
          : { backgroundColor: '#f3f4f6', color: '#374151' }
      }
    >
      {hours % 1 === 0 ? hours : hours.toFixed(1)}h remaining
      {isLow && ' ⚠️'}
    </span>
  )
}

export default function StudentsListClient({ students, initialLowHoursOnly = false, loadError = false }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('All') // All / Private / B2B
  const [tab, setTab] = useState<TabId>(initialLowHoursOnly ? 'low_hours' : 'all')

  const filtered = students.filter((s) => {
    const matchesSearch =
      (s.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase())

    const matchesType = matchesTypeFilter(s, typeFilter)

    return matchesSearch && matchesType && matchesTab(s, tab)
  })

  // Counts follow the Type filter but ignore the search text, so typing never
  // makes a tab look empty.
  const typeMatched = students.filter((s) => matchesTypeFilter(s, typeFilter))

  const counts: Record<TabId, number> = {
    all: typeMatched.filter((s) => matchesTab(s, 'all')).length,
    low_hours: typeMatched.filter((s) => matchesTab(s, 'low_hours')).length,
    on_hold: typeMatched.filter((s) => matchesTab(s, 'on_hold')).length,
    archived: typeMatched.filter((s) => matchesTab(s, 'archived')).length,
  }

  const emptyMessage = search
    ? `No students match "${search}".`
    : tab === 'low_hours'
    ? 'No students are low on hours.'
    : tab === 'on_hold'
    ? 'No students are on hold.'
    : tab === 'archived'
    ? 'No archived students.'
    : 'No students yet.'

  return (
    <div className="p-6">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Students</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {students.length} student{students.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          onClick={() => router.push('/admin/students/new')}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#FF8303' }}
        >
          + Add Student
        </button>
      </div>

      {/* Tab strip */}
      <div
        role="tablist"
        style={{ display: 'flex', gap: '24px', borderBottom: '1px solid #E0DFDC', marginBottom: '20px' }}
      >
        {TABS.map(({ id, label }) => {
          const isActive = tab === id
          const highlightPill = id === 'low_hours' && counts[id] > 0

          return (
            <button
              key={id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(id)}
              style={{
                padding: '10px 2px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                ...(isActive
                  ? {
                      color: '#111827',
                      fontWeight: 600,
                      borderBottom: '2px solid #FF8303',
                      marginBottom: '-1px',
                    }
                  : {
                      color: '#4b5563',
                      fontWeight: 500,
                      borderBottom: '2px solid transparent',
                    }),
              }}
            >
              {label}
              <span
                style={{
                  marginLeft: '8px',
                  padding: '1px 8px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 600,
                  ...(highlightPill
                    ? { backgroundColor: '#FFEEE6', color: '#FD5602' }
                    : { backgroundColor: '#f3f4f6', color: '#4b5563' }),
                }}
              >
                {/* A failed read means the count is unknown, not zero. */}
                {loadError ? '—' : counts[id]}
              </span>
            </button>
          )
        })}
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
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
        >
          <option value="All">All Types</option>
          <option value="Private">Private</option>
          <option value="B2B">B2B</option>
        </select>
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Student</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Company</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Teachers</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Hours</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {loadError ? (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    padding: '32px',
                    textAlign: 'center',
                    borderLeft: '3px solid #FD5602',
                    backgroundColor: '#FFEEE6',
                    color: '#FD5602',
                    fontSize: '14px',
                  }}
                >
                  Couldn&apos;t load students. This is not an empty result - try refreshing.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              filtered.map((student) => (
                <tr
                  key={student.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  onClick={() => router.push(`/admin/students/${student.id}`)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Photo + name as link */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {student.photo_url ? (
                        <img
                          src={student.photo_url}
                          alt={student.full_name ?? ''}
                          className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: '#FF8303' }}
                        >
                          {(student.full_name ?? '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <Link
                        href={`/admin/students/${student.id}`}
                        prefetch={false}
                        className="font-medium text-gray-900 hover:text-orange-500 transition-colors"
                      >
                        {student.full_name || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No name set</span>}
                      </Link>
                    </div>
                  </td>

                  <td className="px-4 py-3 text-gray-600">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{student.email}</span>
                      {student.email_bounced_at ? <EmailBounceBadge /> : null}
                    </div>
                  </td>

                  {/* Company tag — Private badge if no company */}
                  <td className="px-4 py-3">
                    {student.company_name ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                        {student.company_name}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                        Private
                      </span>
                    )}
                  </td>

                  {/* Assigned teachers */}
                  <td className="px-4 py-3">
                    {student.teachers.length === 0 ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {student.teachers.map((t) => (
                          <span
                            key={t.id}
                            className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-50 text-orange-700"
                          >
                            {t.full_name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    <HoursBadge hours={student.hours_remaining} />
                  </td>

                  <td className="px-4 py-3">
                    <StatusBadge status={student.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
