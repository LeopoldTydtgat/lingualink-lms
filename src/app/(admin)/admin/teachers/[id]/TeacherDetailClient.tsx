'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  student_name: string
}

type Invoice = {
  id: string
  month: string
  total_amount: number | null
  status: string | null
  created_at: string
}

type HistoryEntry = {
  id: string
  field_name: string
  old_value: string | null
  new_value: string | null
  changed_by: string
  changed_at: string
}

type Teacher = Record<string, unknown>

type Props = {
  teacher: Teacher
  lessons: Lesson[]
  invoices: Invoice[]
  history: HistoryEntry[]
}

type Tab = 'overview' | 'classes' | 'invoices' | 'history'

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
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={colour}>
      {STATUS_LABEL[status ?? ''] ?? status ?? 'â€“'}
    </span>
  )
}

function LessonStatusBadge({ status }: { status: string }) {
  const colour =
    status === 'completed'
      ? { backgroundColor: '#dcfce7', color: '#166534' }
      : status === 'scheduled'
      ? { backgroundColor: '#dbeafe', color: '#1e40af' }
      : status === 'cancelled'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'student_no_show'
      ? { backgroundColor: '#fef3c7', color: '#92400e' }
      : status === 'teacher_no_show'
      ? { backgroundColor: '#fee2e2', color: '#dc2626' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }

  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium capitalize" style={colour}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function InfoRow({ label, value, adminOnly }: {
  label: string
  value: string | null | undefined
  adminOnly?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-400 flex items-center gap-1">
        {label}
        {adminOnly && (
          <span className="px-1.5 py-0.5 rounded text-xs"
            style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
            Admin only
          </span>
        )}
      </span>
      <span className="text-sm text-gray-800">{value || 'â€“'}</span>
    </div>
  )
}

export default function TeacherDetailClient({ teacher, lessons, invoices, history }: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [deleting, setDeleting] = useState(false)

  const id = teacher.id as string
  const fullName = teacher.full_name as string
  const photoUrl = teacher.photo_url as string | null
  const status = teacher.status as string | null
  const accountTypes = (teacher.account_types as string[]) ?? []

  async function handleSoftDelete() {
    if (!confirm(`Are you sure you want to deactivate ${fullName}? This will set their status to 'Former'.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/teachers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'former', is_active: false }),
      })
      if (!res.ok) throw new Error('Failed to deactivate teacher.')
      router.push('/admin/teachers')
      router.refresh()
    } catch {
      alert('Something went wrong. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'classes', label: `Classes (${lessons.length})` },
    { key: 'invoices', label: `Invoices (${invoices.length})` },
    { key: 'history', label: 'History' },
  ]

  return (
    <div className="p-6 max-w-5xl">
      {/* Back */}
      <button
        onClick={() => router.push('/admin/teachers')}
        className="text-sm text-gray-500 hover:text-gray-700 mb-4 block"
      >
        â† Teachers
      </button>

      {/* Top card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          {/* Left: photo + name */}
          <div className="flex items-center gap-4">
            {photoUrl ? (
              <img src={photoUrl} alt={fullName}
                className="w-16 h-16 rounded-full object-cover" />
            ) : (
              <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold"
                style={{ backgroundColor: '#FF8303' }}>
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500 mb-2">{teacher.email as string}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={status} />
                {accountTypes.map((type) => (
                  <span key={type}
                    className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                    {ROLE_LABEL[type] ?? type}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Right: action buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => router.push(`/admin/teachers/${id}/edit`)}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
            <button
              onClick={() => router.push(`/admin/teachers/${id}/edit?section=public`)}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Edit Public Profile
            </button>
            <button
              onClick={handleSoftDelete}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-sm font-medium border text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
            >
              {deleting ? 'Deactivating...' : 'Deactivate'}
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-5 py-2 text-sm font-medium transition-colors"
            style={activeTab === tab.key
              ? { backgroundColor: '#FF8303', color: 'white' }
              : { backgroundColor: 'white', color: '#6b7280' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          {/* Personal info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Personal Information</h2>
            <InfoRow label="Full Name" value={teacher.full_name as string} />
            <InfoRow label="Email" value={teacher.email as string} />
            <InfoRow label="Phone" value={teacher.phone as string} />
            <InfoRow label="Nationality" value={teacher.nationality as string} />
            <InfoRow label="Gender" value={teacher.gender as string} />
            <InfoRow label="Timezone" value={teacher.timezone as string} />
            <InfoRow label="Street Address" value={teacher.street_address as string} />
            <InfoRow label="Area Code" value={teacher.area_code as string} />
            <InfoRow label="City" value={teacher.city as string} />
          </div>

          {/* Professional info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Professional</h2>
            <InfoRow label="Teaching Languages"
              value={(teacher.teaching_languages as string[] | null)?.join(', ')} />
            <InfoRow label="Native Languages"
              value={(teacher.native_languages as string[] | null)?.join(', ')} />
            <InfoRow label="Specialties" value={teacher.specialties as string} />
            <InfoRow label="Contract Start" value={teacher.contract_start as string} />
            <InfoRow label="Orientation Date" value={teacher.orientation_date as string} />
            <InfoRow label="Observed Lesson Date" value={teacher.observed_lesson_date as string} />
            <InfoRow label="Hourly Rate (â‚¬)"
              value={teacher.hourly_rate != null ? `â‚¬${teacher.hourly_rate}` : null}
              adminOnly />
            <InfoRow label="VAT Required"
              value={teacher.vat_required ? 'Yes' : 'No'}
              adminOnly />
          </div>

          {/* Payment info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Payment Details</h2>
            <InfoRow label="Preferred Payment" value={teacher.preferred_payment_type as string} />
            <InfoRow label="PayPal Email" value={teacher.paypal_email as string} />
            <InfoRow label="IBAN" value={teacher.iban as string} />
            <InfoRow label="BIC" value={teacher.bic as string} />
            <InfoRow label="Tax Number" value={teacher.tax_number as string} />
          </div>

          {/* Follow-up */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Follow-up</h2>
            <InfoRow label="Follow-up Date"
              value={teacher.follow_up_date as string} adminOnly />
            <InfoRow label="Follow-up Reason"
              value={teacher.follow_up_reason as string} adminOnly />
          </div>

          {/* Admin notes â€” full width, amber background */}
          <div className="col-span-2 rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              ðŸ”’ Admin Notes â€” Not visible to teacher
            </h2>
            <p className="text-sm" style={{ color: '#78350f' }}>
              {(teacher.admin_notes as string) || 'No admin notes.'}
            </p>
          </div>

          {/* Bio â€” cast to string and use !! to avoid unknown being treated as ReactNode */}
          {!!(teacher.bio as string) && (
            <div className="col-span-2 bg-white rounded-xl border border-gray-200 p-5 space-y-2">
              <h2 className="font-semibold text-gray-800">Bio</h2>
              <p className="text-sm text-gray-600">{teacher.bio as string}</p>
            </div>
          )}
        </div>
      )}

      {/* Classes tab */}
      {activeTab === 'classes' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Student</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date &amp; Time</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {lessons.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-10 text-gray-400">
                    No classes yet.
                  </td>
                </tr>
              ) : (
                lessons.map((lesson) => (
                  <tr key={lesson.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 text-gray-800">{lesson.student_name}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(lesson.scheduled_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: 'Africa/Johannesburg',
                      })}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{lesson.duration_minutes} min</td>
                    <td className="px-4 py-3">
                      <LessonStatusBadge status={lesson.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoices tab */}
      {activeTab === 'invoices' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Month</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-10 text-gray-400">
                    No invoices yet.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 text-gray-800">{inv.month}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {inv.total_amount != null ? `â‚¬${inv.total_amount}` : 'â€“'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">
                        {inv.status ?? 'â€“'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(inv.created_at).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        timeZone: 'Africa/Johannesburg',
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* History tab */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Field</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Old Value</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">New Value</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">When</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-10 text-gray-400">
                    No changes recorded yet.
                  </td>
                </tr>
              ) : (
                history.map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {entry.field_name.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{entry.old_value || 'â€“'}</td>
                    <td className="px-4 py-3 text-gray-800">{entry.new_value || 'â€“'}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(entry.changed_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: 'Africa/Johannesburg',
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
