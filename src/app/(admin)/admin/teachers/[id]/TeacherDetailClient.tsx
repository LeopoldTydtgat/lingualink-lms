'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// ─── Shared message types (exported so page.tsx can import) ──────────────────

export type AdminMessage = {
  id: string
  sender_id: string
  sender_type: string
  receiver_id: string
  receiver_type: string
  content: string
  attachments: Array<{ url: string; filename: string; size: number }>
  read_at: string | null
  created_at: string
}

export type AdminConversation = {
  contactId: string
  contactName: string
  contactPhotoUrl: string | null
  messages: AdminMessage[]
}

// ─── Domain types ─────────────────────────────────────────────────────────────

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
  conversations: AdminConversation[]
  purgeBlockedBy: string[]
}

type Tab = 'overview' | 'classes' | 'invoices' | 'history' | 'messages'

// ─── Small reusable components ────────────────────────────────────────────────

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
      {STATUS_LABEL[status ?? ''] ?? status ?? '—'}
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
      <span className="text-sm text-gray-800">{value || '—'}</span>
    </div>
  )
}

// ─── Messages helpers ─────────────────────────────────────────────────────────

function msgFormatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    const h = date.getHours().toString().padStart(2, '0')
    const m = date.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').slice(0, 60)
}

function MsgAvatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
  }
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0"
      style={{ backgroundColor: '#FF8303' }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Read-only message thread ─────────────────────────────────────────────────

function MessageThread({
  conversation,
  teacherId,
}: {
  conversation: AdminConversation
  teacherId: string
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.contactId])

  return (
    <>
      {/* Thread header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3 flex-shrink-0 bg-white">
        <MsgAvatar name={conversation.contactName} photoUrl={conversation.contactPhotoUrl} />
        <div>
          <p className="text-sm font-semibold text-gray-900">{conversation.contactName}</p>
          <p className="text-xs text-gray-400">Student</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <style>{`
          .admin-msg-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
          .admin-msg-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
          .admin-msg-bubble li { margin: 0.1rem 0; }
        `}</style>
        {conversation.messages.map((msg, index) => {
          const isFromTeacher = msg.sender_id === teacherId
          const showDate =
            index === 0 ||
            new Date(msg.created_at).toDateString() !==
              new Date(conversation.messages[index - 1].created_at).toDateString()

          return (
            <div key={msg.id}>
              {showDate && (
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {new Date(msg.created_at).toLocaleDateString([], {
                      weekday: 'long', day: 'numeric', month: 'long',
                    })}
                  </span>
                  <div className="flex-1 h-px bg-gray-100" />
                </div>
              )}
              <div className={`flex ${isFromTeacher ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[72%]">
                  <div
                    className="admin-msg-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                    style={
                      isFromTeacher
                        ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                        : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                    }
                    dangerouslySetInnerHTML={{ __html: msg.content }}
                  />
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-1 flex flex-col gap-1">
                      {msg.attachments.map((att, i) => (
                        <a
                          key={i}
                          href={att.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-xs underline opacity-80 hover:opacity-100"
                          style={{ color: isFromTeacher ? '#fff' : '#d1d5db' }}
                        >
                          📎 {att.filename}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className={`flex items-center mt-1 ${isFromTeacher ? 'justify-end' : 'justify-start'}`}>
                    <span className="text-xs text-gray-400">{msgFormatTime(msg.created_at)}</span>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Read-only footer */}
      <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 flex-shrink-0 text-center">
        <span className="text-xs text-gray-400">Read-only — admin view cannot send messages</span>
      </div>
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TeacherDetailClient({ teacher, lessons, invoices, history, conversations, purgeBlockedBy }: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [selectedConversation, setSelectedConversation] = useState<AdminConversation | null>(null)

  // Archive state
  const [archiving, setArchiving] = useState(false)
  const [showArchiveDialog, setShowArchiveDialog] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  // Purge dialog state
  const [showPurgeDialog, setShowPurgeDialog] = useState(false)
  const [purgeConfirmName, setPurgeConfirmName] = useState('')
  const [purging, setPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)

  // Password override state
  const [newPassword, setNewPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  const id = teacher.id as string
  const fullName = teacher.full_name as string
  const photoUrl = teacher.photo_url as string | null
  const status = teacher.status as string | null
  const accountTypes = (teacher.account_types as string[]) ?? []

  const isFormer = status === 'former'
  const purgeReady = isFormer && purgeBlockedBy.length === 0

  function handleArchive() {
    if (isFormer) return
    setArchiveError(null)
    setShowArchiveDialog(true)
  }

  async function handleArchiveConfirm() {
    setArchiving(true)
    setArchiveError(null)
    try {
      const res = await fetch(`/api/admin/teachers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'former', is_active: false }),
      })
      if (!res.ok) throw new Error('Failed to archive teacher.')
      setShowArchiveDialog(false)
      router.push('/admin/teachers')
      router.refresh()
    } catch {
      setArchiveError('Something went wrong. Please try again.')
    } finally {
      setArchiving(false)
    }
  }

  async function handlePurge() {
    if (purgeConfirmName !== fullName) return
    setPurgeError(null)
    setPurging(true)
    try {
      const res = await fetch(`/api/admin/teachers/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to purge teacher.')
      setShowPurgeDialog(false)
      router.push('/admin/teachers')
      router.refresh()
    } catch (err: unknown) {
      setPurgeError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPurging(false)
    }
  }

  async function handleSetPassword() {
    setPasswordError(null)
    setPasswordSuccess(false)
    if (newPassword.length < 8) {
      return setPasswordError('Password must be at least 8 characters.')
    }
    setPasswordSaving(true)
    try {
      const res = await fetch(`/api/admin/teachers/${id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to set password.')
      setNewPassword('')
      setPasswordSuccess(true)
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPasswordSaving(false)
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'classes', label: `Classes (${lessons.length})` },
    { key: 'invoices', label: `Invoices (${invoices.length})` },
    { key: 'history', label: 'History' },
    { key: 'messages', label: `Messages (${conversations.length})` },
  ]

  return (
    <div className="p-6 max-w-5xl">
      {/* Back */}
      <button
        onClick={() => router.push('/admin/teachers')}
        className="text-sm text-gray-500 hover:text-gray-700 mb-4 block"
      >
        ← Teachers
      </button>

      {/* Top card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
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

          {/* Right: action buttons + purge block notice */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="flex gap-2 flex-wrap justify-end">
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
                onClick={handleArchive}
                disabled={archiving || isFormer}
                className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50"
                style={isFormer
                  ? { borderColor: '#d1d5db', color: '#9ca3af', cursor: 'default' }
                  : { borderColor: '#fed7aa', color: '#c2410c' }}
              >
                {archiving ? 'Archiving...' : isFormer ? 'Archived' : 'Archive'}
              </button>
              {isFormer && (
                <button
                  onClick={() => { setPurgeError(null); setPurgeConfirmName(''); setShowPurgeDialog(true) }}
                  disabled={!purgeReady}
                  className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ borderColor: '#fca5a5', color: '#dc2626' }}
                  title={!purgeReady ? `Purge blocked: archive linked students first` : undefined}
                >
                  Purge
                </button>
              )}
            </div>

            {/* Purge blocked notice */}
            {isFormer && purgeBlockedBy.length > 0 && (
              <div
                className="text-xs rounded-lg px-3 py-2 max-w-xs text-right"
                style={{ backgroundColor: '#fefce8', borderColor: '#fde68a', border: '1px solid #fde68a', color: '#92400e' }}
              >
                <p className="font-medium">Purge blocked — archive these students first:</p>
                <p className="mt-0.5">{purgeBlockedBy.join(', ')}</p>
              </div>
            )}
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
            <InfoRow label="Hourly Rate (€)"
              value={teacher.hourly_rate != null ? `€${parseFloat(Number(teacher.hourly_rate).toFixed(2)).toString()}` : null}
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

          {/* Admin notes — full width, amber background */}
          <div className="col-span-2 rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              🔒 Admin Notes — Not visible to teacher
            </h2>
            <p className="text-sm" style={{ color: '#78350f' }}>
              {(teacher.admin_notes as string) || 'No admin notes.'}
            </p>
          </div>

          {/* Password override — admin only */}
          <div className="col-span-2 rounded-xl border p-5 space-y-3"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              🔑 Set New Password — Admin only
            </h2>
            <p className="text-xs" style={{ color: '#78350f' }}>
              Overrides the teacher&apos;s current password immediately. The teacher is not notified.
            </p>

            {passwordError && (
              <div className="text-sm rounded-lg px-4 py-2"
                style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
                {passwordError}
              </div>
            )}
            {passwordSuccess && (
              <div className="text-sm rounded-lg px-4 py-2"
                style={{ backgroundColor: '#f0fdf4', color: '#166534' }}>
                Password updated successfully.
              </div>
            )}

            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-xs font-medium mb-1" style={{ color: '#92400e' }}>
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordSuccess(false); setPasswordError(null) }}
                  placeholder="Min. 8 characters"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#fde68a', backgroundColor: 'white' }}
                />
              </div>
              <button
                onClick={handleSetPassword}
                disabled={passwordSaving || !newPassword}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 flex-shrink-0"
                style={{ backgroundColor: '#92400e' }}
              >
                {passwordSaving ? 'Saving...' : 'Set Password'}
              </button>
            </div>
          </div>

          {/* Bio */}
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
                      {inv.total_amount != null ? `€${inv.total_amount}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">
                        {inv.status ?? '—'}
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
                    <td className="px-4 py-3 text-gray-500">{entry.old_value || '—'}</td>
                    <td className="px-4 py-3 text-gray-800">{entry.new_value || '—'}</td>
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

      {/* Messages tab */}
      {activeTab === 'messages' && (
        conversations.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <p className="text-gray-400 text-sm">No conversations yet.</p>
          </div>
        ) : (
          <div
            className="flex bg-white rounded-xl border border-gray-200 overflow-hidden"
            style={{ height: '620px' }}
          >
            {/* Left: conversation list */}
            <div className="w-64 border-r border-gray-200 flex flex-col flex-shrink-0">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-700">Student conversations</p>
              </div>
              <div className="flex-1 overflow-y-auto">
                {conversations.map((conv) => {
                  const lastMsg = conv.messages[conv.messages.length - 1]
                  const isSelected = selectedConversation?.contactId === conv.contactId
                  return (
                    <button
                      key={conv.contactId}
                      onClick={() => setSelectedConversation(conv)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50"
                      style={isSelected ? { backgroundColor: '#FFF3E0' } : {}}
                    >
                      <MsgAvatar name={conv.contactName} photoUrl={conv.contactPhotoUrl} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-sm font-medium text-gray-700 truncate">
                            {conv.contactName}
                          </span>
                          {lastMsg && (
                            <span className="text-xs text-gray-400 flex-shrink-0">
                              {msgFormatTime(lastMsg.created_at)}
                            </span>
                          )}
                        </div>
                        {lastMsg && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            {stripHtml(lastMsg.content)}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Right: thread */}
            <div className="flex-1 flex flex-col min-w-0">
              {!selectedConversation ? (
                <div className="flex-1 flex items-center justify-center text-gray-400">
                  <p className="text-sm">Select a conversation to read the thread</p>
                </div>
              ) : (
                <MessageThread
                  conversation={selectedConversation}
                  teacherId={id}
                />
              )}
            </div>
          </div>
        )
      )}

      {/* ─── Archive confirmation dialog ──────────────────────────────────────────── */}
      {showArchiveDialog && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
        >
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              Archive {fullName}?
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              This will set their status to <strong className="text-gray-700">Former</strong> and
              deactivate their account. You can still purge them later if needed.
            </p>

            {archiveError && (
              <div
                className="text-sm rounded-lg px-4 py-3 mb-4"
                style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}
              >
                {archiveError}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowArchiveDialog(false); setArchiveError(null) }}
                disabled={archiving}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleArchiveConfirm}
                disabled={archiving}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#c2410c' }}
              >
                {archiving ? 'Archiving...' : 'Archive Teacher'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Purge confirmation dialog ─────────────────────────────────────────── */}
      {showPurgeDialog && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
        >
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              Permanently purge {fullName}?
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              This will permanently delete all classes, invoices, messages, reviews, and the account itself.
              <strong className="text-gray-700"> This cannot be undone.</strong>
            </p>

            {purgeError && (
              <div
                className="text-sm rounded-lg px-4 py-3 mb-4"
                style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}
              >
                {purgeError}
              </div>
            )}

            <label className="block text-sm font-medium text-gray-700 mb-1">
              Type <span className="font-semibold">{fullName}</span> to confirm:
            </label>
            <input
              type="text"
              value={purgeConfirmName}
              onChange={(e) => setPurgeConfirmName(e.target.value)}
              placeholder={fullName}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-5 focus:outline-none focus:border-red-400"
              autoFocus
            />

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowPurgeDialog(false); setPurgeConfirmName(''); setPurgeError(null) }}
                disabled={purging}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePurge}
                disabled={purgeConfirmName !== fullName || purging}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#dc2626' }}
              >
                {purging ? 'Purging...' : 'Permanently Purge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
