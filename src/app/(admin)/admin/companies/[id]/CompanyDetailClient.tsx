'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Users, FileText, Pencil } from 'lucide-react'

type Student = {
  id: string
  full_name: string
  email: string
  status: string | null
  cancellation_policy: string | null
  hours_remaining: number | null
  end_date: string | null
  teacher_names: string[]
}

type Company = Record<string, unknown>

type Props = {
  company: Company
  students: Student[]
}

type Tab = 'info' | 'students' | 'notes'

const TYPE_LABELS: Record<string, string> = {
  b2b: 'B2B',
  enterprise: 'Enterprise',
  partner: 'Partner',
}

const STATUS_COLOURS: Record<string, { bg: string; text: string }> = {
  current: { bg: '#dcfce7', text: '#166534' },
  former:  { bg: '#f3f4f6', text: '#6b7280' },
  on_hold: { bg: '#fef3c7', text: '#92400e' },
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-4 py-2.5 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-500 w-44 flex-shrink-0">{label}</span>
      <span className="text-sm text-gray-900">{value || '—'}</span>
    </div>
  )
}

export default function CompanyDetailClient({ company, students }: Props) {
  const router = useRouter()
  const id = company.id as string
  const [activeTab, setActiveTab] = useState<Tab>('info')

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'info',     label: 'General Info', icon: <Building2 size={15} /> },
    { key: 'students', label: `Students (${students.length})`, icon: <Users size={15} /> },
    { key: 'notes',    label: 'Notes',        icon: <FileText size={15} /> },
  ]

  const tagsArr = Array.isArray(company.tags) ? company.tags as string[] : []

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/admin/companies')}
            className="text-sm text-gray-500 hover:text-gray-700">
            ← Companies
          </button>
          <span className="text-gray-300">/</span>
          <h1 className="text-2xl font-bold text-gray-900">{company.name as string}</h1>
          {(company.status as string) && (
            <span className="px-2.5 py-0.5 rounded-full text-xs font-medium capitalize"
              style={{ backgroundColor: '#dcfce7', color: '#166534' }}>
              {company.status as string}
            </span>
          )}
        </div>
        <button
          onClick={() => router.push(`/admin/companies/${id}/edit`)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          <Pencil size={14} />
          Edit
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium transition-colors"
            style={activeTab === t.key
              ? { backgroundColor: '#FF8303', color: 'white' }
              : { backgroundColor: 'white', color: '#6b7280' }}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ── General Info ── */}
      {activeTab === 'info' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-1">
          <InfoRow label="Company Name"     value={company.name as string} />
          <InfoRow label="Type"             value={TYPE_LABELS[company.type as string] ?? (company.type as string)} />
          <InfoRow label="Contact Person"   value={company.contact_name as string} />
          <InfoRow label="Contact Email"    value={company.contact_email as string} />
          <InfoRow label="Contact Phone"    value={company.contact_phone as string} />
          <InfoRow label="Country"          value={company.country as string} />
          <InfoRow label="Billing Email"    value={company.billing_email as string} />
          <div className="flex gap-4 py-2.5 border-b border-gray-50">
            <span className="text-sm text-gray-500 w-44 flex-shrink-0">Cancellation Policy</span>
            <span className="px-2 py-0.5 rounded text-xs font-medium"
              style={company.cancellation_policy === '48hr'
                ? { backgroundColor: '#fef3c7', color: '#92400e' }
                : { backgroundColor: '#f3f4f6', color: '#6b7280' }}>
              {(company.cancellation_policy as string) ?? '24hr'}
            </span>
          </div>
          {tagsArr.length > 0 && (
            <div className="flex gap-4 py-2.5">
              <span className="text-sm text-gray-500 w-44 flex-shrink-0">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {tagsArr.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{ backgroundColor: '#f3f4f6', color: '#374151' }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Students ── */}
      {activeTab === 'students' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {students.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Users size={36} className="mb-3 opacity-30" />
              <p className="text-sm">No students attached to this company</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Student</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Teacher(s)</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Hours Left</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">End Date</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Policy</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const colours = STATUS_COLOURS[s.status ?? ''] ?? { bg: '#f3f4f6', text: '#6b7280' }
                  const lowHours = s.hours_remaining !== null && s.hours_remaining < 2
                  return (
                    <tr key={s.id}
                      className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => router.push(`/admin/students/${s.id}`)}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{s.full_name}</div>
                        <div className="text-xs text-gray-400">{s.email}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {s.teacher_names.length > 0 ? s.teacher_names.join(', ') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {s.hours_remaining !== null ? (
                          <span className="font-medium"
                            style={{ color: lowHours ? '#dc2626' : '#111827' }}>
                            {s.hours_remaining.toFixed(1)}h
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {s.end_date ? new Date(s.end_date).toLocaleDateString('en-GB') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium"
                          style={s.cancellation_policy === '48hr'
                            ? { backgroundColor: '#fef3c7', color: '#92400e' }
                            : { backgroundColor: '#f3f4f6', color: '#6b7280' }}>
                          {s.cancellation_policy ?? '24hr'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                          style={{ backgroundColor: colours.bg, color: colours.text }}>
                          {s.status ?? 'current'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Notes ── */}
      {activeTab === 'notes' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="rounded-lg p-4" style={{ backgroundColor: '#fffbeb' }}>
            <p className="text-sm font-semibold mb-2" style={{ color: '#92400e' }}>
              🔒 Admin Only
            </p>
            {company.notes ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{company.notes as string}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No notes added yet.</p>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => router.push(`/admin/companies/${id}/edit`)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
              <Pencil size={14} />
              Edit Notes
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
