'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type Teacher = {
  id: string
  full_name: string
}

type Student = {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  status: string | null
  is_private: boolean
  company_id: string | null
  company_name: string | null
  hours_remaining: number | null
  teachers: Teacher[]
}

type Props = {
  students: Student[]
}

const STATUS_OPTIONS = ['All', 'current', 'former', 'on_hold']

const STATUS_LABEL: Record<string, string> = {
  current: 'Current',
  former: 'Former',
  on_hold: 'On Hold',
}

const LOW_HOURS_THRESHOLD = 2

function StatusBadge({ status }: { status: string | null }) {
  const colour =
    status === 'current'
      ? { backgroundColor: '#dcfce7', color: '#166534' }
      : status === 'former'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'on_hold'
      ? { backgroundColor: '#fef9c3', color: '#854d0e' }
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
          ? { backgroundColor: '#fee2e2', color: '#991b1b' }
          : { backgroundColor: '#f3f4f6', color: '#374151' }
      }
    >
      {hours % 1 === 0 ? hours : hours.toFixed(1)}h remaining
      {isLow && ' ⚠️'}
    </span>
  )
}

export default function StudentsListClient({ students }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [typeFilter, setTypeFilter] = useState('All') // All / Private / B2B
  const [lowHoursOnly, setLowHoursOnly] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const filtered = students.filter((s) => {
    const matchesSearch =
      s.full_name.toLowerCase().includes(search.toLowerCase()) ||
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
      <div className="flex items-center justify-between mb-6">
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
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
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
          ⚠️ Low Hours
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

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  No students found.
                </td>
              </tr>
            ) : (
              filtered.map((student) => (
                <tr
                  key={student.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                >
                  {/* Photo + name as link */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {student.photo_url ? (
                        <img
                          src={student.photo_url}
                          alt={student.full_name}
                          className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: '#FF8303' }}
                        >
                          {student.full_name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <Link
                        href={`/admin/students/${student.id}`}
                        prefetch={false}
                        className="font-medium text-gray-900 hover:text-orange-500 transition-colors"
                      >
                        {student.full_name}
                      </Link>
                    </div>
                  </td>

                  <td className="px-4 py-3 text-gray-600">{student.email}</td>

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
