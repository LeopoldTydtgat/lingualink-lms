'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { EmailBounceBadge } from '@/components/EmailBounceBadge'

type Teacher = {
  id: string
  full_name: string | null
  email: string
  photo_url: string | null
  status: string | null
  account_types: string[] | null
  hourly_rate: number | null
  currency: string | null
  role: string
  email_bounced_at: string | null
  email_bounce_reason: string | null
  lesson_count: number
}

type Props = {
  teachers: Teacher[]
  // True when the server-side read failed. An empty table would read as
  // "no teachers", so the list renders an error state instead.
  loadError?: boolean
}

const ROLE_LABEL: Record<string, string> = {
  teacher: 'Teacher',
  teacher_exam: 'Teacher+Exam',
  staff: 'Staff',
}

const STATUS_LABEL: Record<string, string> = {
  current: 'Current',
  former: 'Former',
  on_hold: 'On Hold',
}

type TabId = 'all' | 'on_hold' | 'archived'

const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All Teachers' },
  { id: 'on_hold', label: 'On Hold' },
  { id: 'archived', label: 'Archived' },
]

// Single implementation shared by the list filter and the tab counts, so a tab's
// number can never disagree with the rows that tab shows. This also removes the
// old status-dropdown-ANDed-with-Show-Archived shape by construction: there is
// only one status control now, so two of them cannot contradict each other.
function matchesTab(t: Teacher, tab: TabId): boolean {
  if (tab === 'archived') return t.status === 'former'
  if (tab === 'on_hold') return t.status === 'on_hold'
  // 'all' is deliberately "not former" rather than "is current", so a row with a
  // null or unrecognised status is still visible somewhere.
  return t.status !== 'former'
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

// Roles. Every account carries 'teacher', so a pill on that value repeats on
// every row and reads as noise; it renders as plain text. The extras that
// actually vary between people (Staff, Teacher+Exam) keep a pill so they stand
// out. Falls back to the role column when account_types is null.
function RoleList({ types }: { types: string[] }) {
  const base = types.filter((t) => t === 'teacher')
  const extras = types.filter((t) => t !== 'teacher')

  if (types.length === 0) {
    return <span className="text-gray-400">&mdash;</span>
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {base.length > 0 && (
        <span style={{ fontSize: '13px', color: '#374151' }}>
          {ROLE_LABEL.teacher}
        </span>
      )}
      {extras.map((type) => (
        <span
          key={type}
          className="px-2 py-0.5 rounded-full text-xs font-medium"
          style={{ backgroundColor: '#FFEEE6', color: '#FD5602' }}
        >
          {ROLE_LABEL[type] ?? type}
        </span>
      ))}
    </div>
  )
}

export default function TeachersListClient({ teachers, loadError = false }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<TabId>('all')

  // Trimmed once so a pasted trailing space cannot silently empty the table.
  const query = search.trim().toLowerCase()

  const filtered = teachers.filter((t) => {
    const matchesSearch =
      query === '' ||
      (t.full_name ?? '').toLowerCase().includes(query) ||
      t.email.toLowerCase().includes(query)
    return matchesSearch && matchesTab(t, tab)
  })

  // Counts ignore the search text, so typing never makes a tab look empty.
  const counts: Record<TabId, number> = {
    all: teachers.filter((t) => matchesTab(t, 'all')).length,
    on_hold: teachers.filter((t) => matchesTab(t, 'on_hold')).length,
    archived: teachers.filter((t) => matchesTab(t, 'archived')).length,
  }

  // A failed read means the number is unknown, not zero. The archived share is
  // no longer named here - the Archived tab carries its own count.
  const countLabel = loadError
    ? 'Teachers unavailable'
    : `${teachers.length} teacher${teachers.length !== 1 ? 's' : ''} total`

  const emptyMessage = query
    ? `No teachers match "${query}".`
    : tab === 'on_hold'
    ? 'No teachers are on hold.'
    : tab === 'archived'
    ? 'No archived teachers.'
    : 'No teachers yet.'

  return (
    <div className="p-6">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Teachers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {countLabel}
          </p>
        </div>
        <button
          onClick={() => router.push('/admin/teachers/new')}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#FF8303' }}
        >
          + Add Teacher
        </button>
      </div>

      {/* Tab strip */}
      <div
        role="tablist"
        style={{ display: 'flex', gap: '24px', borderBottom: '1px solid #E0DFDC', marginBottom: '20px' }}
      >
        {TABS.map(({ id, label }) => {
          const isActive = tab === id

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
                  backgroundColor: '#f3f4f6',
                  color: '#4b5563',
                }}
              >
                {/* A failed read means the count is unknown, not zero. */}
                {loadError ? '—' : counts[id]}
              </span>
            </button>
          )
        })}
      </div>

      {/* Search */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-orange-400"
        />
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Teacher</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Roles</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Rate/hr</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Classes</th>
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
                  Couldn&apos;t load teachers. This is not an empty result - try refreshing.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              filtered.map((teacher) => (
                <tr
                  key={teacher.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  onClick={() => router.push(`/admin/teachers/${teacher.id}`)}
                  // Keyboard parity with the click handler. No role="button" - that
                  // would strip the row out of the table semantics screen readers use.
                  tabIndex={0}
                  aria-label={`Open ${teacher.full_name ?? 'teacher'}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      // Space would otherwise scroll the page.
                      if (e.key === ' ') e.preventDefault()
                      router.push(`/admin/teachers/${teacher.id}`)
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Photo + name as link */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {teacher.photo_url ? (
                        <img
                          src={teacher.photo_url}
                          alt={teacher.full_name ?? ''}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: '#FF8303' }}
                        >
                          {(teacher.full_name ?? '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      {/* Kept for the hover affordance and open-in-new-tab, but taken out
                          of the tab order: the row is already the tab stop for this href. */}
                      <Link
                        href={`/admin/teachers/${teacher.id}`}
                        prefetch={false}
                        tabIndex={-1}
                        className="font-medium text-gray-900 hover:text-orange-500 transition-colors"
                      >
                        {teacher.full_name || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No name set</span>}
                      </Link>
                    </div>
                  </td>

                  <td className="px-4 py-3 text-gray-600">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{teacher.email}</span>
                      {teacher.email_bounced_at ? <EmailBounceBadge /> : null}
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    <StatusBadge status={teacher.status} />
                  </td>

                  <td className="px-4 py-3">
                    <RoleList types={teacher.account_types ?? [teacher.role]} />
                  </td>

                  <td className="px-4 py-3 text-gray-600">
                    {teacher.hourly_rate != null
                      ? `${({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[teacher.currency ?? 'EUR'] ?? '€'}${parseFloat(Number(teacher.hourly_rate).toFixed(2)).toString()}`
                      : '—'}
                  </td>

                  <td className="px-4 py-3 text-gray-600">{teacher.lesson_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
