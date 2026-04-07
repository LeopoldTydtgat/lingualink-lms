'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type Teacher = {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  status: string | null
  account_types: string[] | null
  hourly_rate: number | null
  role: string
  lesson_count: number
}

type Props = {
  teachers: Teacher[]
}

const STATUS_OPTIONS = ['All', 'current', 'former', 'on_hold']

const ROLE_LABEL: Record<string, string> = {
  teacher: 'Teacher',
  teacher_exam: 'Teacher+Exam',
  staff: 'Staff',
  hr_admin: 'HR Admin',
  school_admin: 'School Admin',
}

const STATUS_LABEL: Record<string, string> = {
  current: 'Current',
  former: 'Former',
  on_hold: 'On Hold',
}

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

export default function TeachersListClient({ teachers }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')

  const filtered = teachers.filter((t) => {
    const matchesSearch =
      t.full_name.toLowerCase().includes(search.toLowerCase()) ||
      t.email.toLowerCase().includes(search.toLowerCase())
    const matchesStatus =
      statusFilter === 'All' || t.status === statusFilter
    return matchesSearch && matchesStatus
  })

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Teachers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {teachers.length} teacher{teachers.length !== 1 ? 's' : ''} total
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

      {/* Search and filters */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
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
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Teacher</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Roles</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Rate (€/hr)</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Classes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  No teachers found.
                </td>
              </tr>
            ) : (
              filtered.map((teacher) => (
                <tr
                  key={teacher.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                >
                  {/* Photo + name as link */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {teacher.photo_url ? (
                        <img
                          src={teacher.photo_url}
                          alt={teacher.full_name}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: '#FF8303' }}
                        >
                          {teacher.full_name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <Link
                        href={`/admin/teachers/${teacher.id}`}
                        className="font-medium text-gray-900 hover:text-orange-500 transition-colors"
                      >
                        {teacher.full_name}
                      </Link>
                    </div>
                  </td>

                  <td className="px-4 py-3 text-gray-600">{teacher.email}</td>

                  <td className="px-4 py-3">
                    <StatusBadge status={teacher.status} />
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(teacher.account_types ?? [teacher.role]).map((type) => (
                        <span
                          key={type}
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700"
                        >
                          {ROLE_LABEL[type] ?? type}
                        </span>
                      ))}
                    </div>
                  </td>

                  <td className="px-4 py-3 text-gray-600">
                    {teacher.hourly_rate != null ? `€${teacher.hourly_rate}` : '—'}
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