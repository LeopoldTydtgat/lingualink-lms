'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Building2, Plus, Search } from 'lucide-react'

type Company = {
  id: string
  name: string
  type: string | null
  contact_name: string | null
  contact_email: string | null
  status: string | null
  cancellation_policy: string | null
  student_count: number
}

const STATUS_COLOURS: Record<string, { bg: string; text: string }> = {
  active:  { bg: '#dcfce7', text: '#166534' },
  former:  { bg: '#f3f4f6', text: '#6b7280' },
}

const TYPE_LABELS: Record<string, string> = {
  b2b: 'B2B',
  enterprise: 'Enterprise',
  partner: 'Partner',
}

export default function CompaniesListClient({ companies }: { companies: Company[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const filtered = companies.filter((c) => {
    const matchSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.contact_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (c.contact_email ?? '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchStatus
  })

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Companies</h1>
          <p className="text-sm text-gray-500 mt-0.5">{companies.length} total</p>
        </div>
        <button
          onClick={() => router.push('/admin/companies/new')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#FF8303' }}
        >
          <Plus size={16} />
          Add Company
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-orange-400"
            placeholder="Search by name, contact..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-orange-400"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="former">Former</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Building2 size={40} className="mb-3 opacity-30" />
            <p className="text-sm">No companies found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Company</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Contact</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Students</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Policy</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const colours = STATUS_COLOURS[c.status ?? ''] ?? { bg: '#f3f4f6', text: '#6b7280' }
                return (
                  <tr
                    key={c.id}
                    className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => router.push(`/admin/companies/${c.id}`)}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {TYPE_LABELS[c.type ?? ''] ?? c.type ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      <div>{c.contact_name ?? '—'}</div>
                      {c.contact_email && (
                        <div className="text-xs text-gray-400">{c.contact_email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700 font-medium">{c.student_count}</td>
                    <td className="px-4 py-3 text-gray-500">
                      <span
                        className="px-2 py-0.5 rounded text-xs font-medium"
                        style={
                          c.cancellation_policy === '48hr'
                            ? { backgroundColor: '#fef3c7', color: '#92400e' }
                            : { backgroundColor: '#f3f4f6', color: '#6b7280' }
                        }
                      >
                        {c.cancellation_policy ?? '24hr'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                        style={{ backgroundColor: colours.bg, color: colours.text }}
                      >
                        {c.status ?? 'active'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
