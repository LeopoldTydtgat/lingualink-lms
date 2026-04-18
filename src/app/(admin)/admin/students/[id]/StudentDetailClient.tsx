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

// ── Domain types ─────────────────────────────────────────────────────────────

type Teacher = { id: string; full_name: string }

type Training = {
  id: string
  package_name: string | null
  package_type: string | null
  total_hours: number
  hours_consumed: number
  end_date: string | null
  status: string | null
  created_at: string
}

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  teacher_name: string
}

type HoursLogEntry = {
  id: string
  type: string
  amount_hours: number
  balance_after: number
  invoice_reference: string | null
  notes: string | null
  created_at: string
}

type Report = {
  id: string
  happened: boolean | null
  feedback: string | null
  created_at: string
  class_id: string
  lesson_scheduled_at: string | null
  teacher_name: string | null
}

type Review = {
  id: string
  rating: number
  review_text: string | null
  submitted_at: string
  admin_edited_text: string | null
  moderated_by_admin: boolean
  teacher_name: string
}

type Props = {
  student: Record<string, unknown>
  companyName: string | null
  activeTrain: Training | null
  hoursRemaining: number | null
  assignedTeachers: Teacher[]
  lessons: Lesson[]
  hoursLog: HoursLogEntry[]
  reports: Report[]
  reviews: Review[]
  conversations: AdminConversation[]
  purgeBlockedBy: string[]
}

type Tab = 'overview' | 'classes' | 'hours' | 'reports' | 'messages' | 'reviews'

// ── Small reusable components ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  const colour =
    status === 'current'
      ? { backgroundColor: '#dcfce7', color: '#166534' }
      : status === 'former'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'on_hold'
      ? { backgroundColor: '#fef9c3', color: '#854d0e' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }
  const label: Record<string, string> = {
    current: 'Current', former: 'Former', on_hold: 'On Hold',
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={colour}>
      {label[status ?? ''] ?? status ?? '—'}
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

function HoursTypeBadge({ type }: { type: string }) {
  const colour =
    type === 'add'
      ? { backgroundColor: '#dcfce7', color: '#166534' }
      : type === 'deduct' || type === 'class_booking'
      ? { backgroundColor: '#fee2e2', color: '#991b1b' }
      : type === 'cancellation_refund'
      ? { backgroundColor: '#dbeafe', color: '#1e40af' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }
  const label: Record<string, string> = {
    add: 'Add',
    deduct: 'Deduct',
    class_booking: 'Class Booking',
    cancellation_refund: 'Cancellation Refund',
    admin_adjustment: 'Admin Adjustment',
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={colour}>
      {label[type] ?? type}
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

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} style={{ color: star <= rating ? '#FF8303' : '#e5e7eb' }}>
          ★
        </span>
      ))}
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
  studentId,
}: {
  conversation: AdminConversation
  studentId: string
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
          <p className="text-xs text-gray-400">Teacher</p>
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
          const isFromStudent = msg.sender_id === studentId
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
              <div className={`flex ${isFromStudent ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[72%]">
                  <div
                    className="admin-msg-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                    style={
                      isFromStudent
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
                          style={{ color: isFromStudent ? '#fff' : '#d1d5db' }}
                        >
                          📎 {att.filename}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className={`flex items-center mt-1 ${isFromStudent ? 'justify-end' : 'justify-start'}`}>
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

// ── Main component ────────────────────────────────────────────────────────────

export default function StudentDetailClient({
  student,
  companyName,
  activeTrain,
  hoursRemaining,
  assignedTeachers,
  lessons,
  hoursLog,
  reports,
  reviews,
  conversations,
  purgeBlockedBy,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  // Hours log form state
  const [hoursAction, setHoursAction] = useState<'add' | 'remove' | null>(null)
  const [hoursAmount, setHoursAmount] = useState('')
  const [invoiceRef, setInvoiceRef] = useState('')
  const [hoursNotes, setHoursNotes] = useState('')
  const [hoursSaving, setHoursSaving] = useState(false)
  const [hoursError, setHoursError] = useState<string | null>(null)

  // Archive state
  const [archiving, setArchiving] = useState(false)
  const [showArchiveDialog, setShowArchiveDialog] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  // Purge state
  const [showPurgeDialog, setShowPurgeDialog] = useState(false)
  const [purgeConfirmName, setPurgeConfirmName] = useState('')
  const [purging, setPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)

  // Messages state
  const [selectedConversation, setSelectedConversation] = useState<AdminConversation | null>(null)

  // Password override state
  const [newPassword, setNewPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  const id = student.id as string
  const fullName = student.full_name as string
  const photoUrl = student.photo_url as string | null
  const status = student.status as string | null

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
      const res = await fetch(`/api/admin/students/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'former' }),
      })
      if (!res.ok) throw new Error('Failed to archive student.')
      setShowArchiveDialog(false)
      router.push('/admin/students')
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
      const res = await fetch(`/api/admin/students/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to purge student.')
      setShowPurgeDialog(false)
      router.push('/admin/students')
      router.refresh()
    } catch (err: unknown) {
      setPurgeError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPurging(false)
    }
  }

  async function handleHoursSubmit() {
    setHoursError(null)
    if (!hoursAmount || isNaN(parseFloat(hoursAmount)) || parseFloat(hoursAmount) <= 0) {
      return setHoursError('Enter a valid number of hours.')
    }
    if (hoursAction === 'remove' && !hoursNotes.trim()) {
      return setHoursError('Notes are required when removing hours.')
    }
    setHoursSaving(true)
    try {
      const res = await fetch(`/api/admin/students/${id}/hours`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: hoursAction,
          amount: parseFloat(hoursAmount),
          invoice_reference: invoiceRef || null,
          notes: hoursNotes || null,
          training_id: activeTrain?.id ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to update hours.')
      setHoursAction(null)
      setHoursAmount('')
      setInvoiceRef('')
      setHoursNotes('')
      router.refresh()
    } catch (err: unknown) {
      setHoursError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setHoursSaving(false)
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
      const res = await fetch(`/api/admin/students/${id}/password`, {
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
    { key: 'hours', label: `Hours Log (${hoursLog.length})` },
    { key: 'reports', label: `Reports (${reports.length})` },
    { key: 'messages', label: `Messages (${conversations.length})` },
    { key: 'reviews', label: `Reviews (${reviews.length})` },
  ]

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'

  return (
    <div className="p-6 max-w-5xl">
      {/* Back */}
      <button
        onClick={() => router.push('/admin/students')}
        className="text-sm text-gray-500 hover:text-gray-700 mb-4 block"
      >
        ← Students
      </button>

      {/* Top card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            {photoUrl ? (
              <img src={photoUrl} alt={fullName}
                className="w-16 h-16 rounded-full object-cover" />
            ) : (
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold"
                style={{ backgroundColor: '#FF8303' }}
              >
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500 mb-2">{student.email as string}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={status} />
                {companyName ? (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                    {companyName}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                    Private
                  </span>
                )}
                {hoursRemaining !== null && (
                  <span
                    className="px-2 py-0.5 rounded-full text-xs font-medium"
                    style={
                      hoursRemaining < 2
                        ? { backgroundColor: '#fee2e2', color: '#991b1b' }
                        : { backgroundColor: '#f3f4f6', color: '#374151' }
                    }
                  >
                    {hoursRemaining % 1 === 0 ? hoursRemaining : hoursRemaining.toFixed(1)}h remaining
                    {hoursRemaining < 2 && ' ⚠️'}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons + purge block notice */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="flex gap-2 flex-wrap justify-end">
              <button
                onClick={() => router.push(`/admin/students/${id}/edit`)}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Edit
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
                  title={!purgeReady ? `Purge blocked: archive linked teachers first` : undefined}
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
                <p className="font-medium">Purge blocked — archive these teachers first:</p>
                <p className="mt-0.5">{purgeBlockedBy.join(', ')}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit flex-wrap">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-5 py-2 text-sm font-medium transition-colors"
            style={
              activeTab === tab.key
                ? { backgroundColor: '#FF8303', color: 'white' }
                : { backgroundColor: 'white', color: '#6b7280' }
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          {/* Personal info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Personal Information</h2>
            <InfoRow label="Full Name" value={fullName} />
            <InfoRow label="Email" value={student.email as string} />
            <InfoRow label="Phone" value={student.phone as string} />
            <InfoRow label="Date of Birth" value={student.date_of_birth as string} adminOnly />
            <InfoRow label="Timezone" value={student.timezone as string} />
            <InfoRow label="Language Preference" value={student.language_preference as string} />
            <InfoRow label="Customer Number" value={student.customer_number as string} adminOnly />
            <InfoRow label="Cancellation Policy" value={student.cancellation_policy as string} adminOnly />
          </div>

          {/* Learning info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Learning Info</h2>
            <InfoRow label="Native Language" value={student.native_language as string} />
            <InfoRow label="Learning Language" value={student.learning_language as string} />
            <InfoRow label="Current Fluency Level" value={student.current_fluency_level as string} />
            <InfoRow label="Self-Assessed Level" value={student.self_assessed_level as string} />
            <InfoRow label="Learning Goals" value={student.learning_goals as string} />
            <InfoRow label="Interests" value={student.interests as string} />
          </div>

          {/* Training info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Training</h2>
            {activeTrain ? (
              <>
                <InfoRow label="Package" value={activeTrain.package_name ?? activeTrain.package_type} />
                <InfoRow label="Total Hours" value={`${activeTrain.total_hours}h`} />
                <InfoRow label="Hours Used" value={`${activeTrain.hours_consumed}h`} />
                <InfoRow
                  label="Hours Remaining"
                  value={hoursRemaining !== null
                    ? `${hoursRemaining % 1 === 0 ? hoursRemaining : hoursRemaining.toFixed(1)}h`
                    : null}
                />
                <InfoRow label="End Date" value={activeTrain.end_date ?? null} />
                <InfoRow label="Status" value={activeTrain.status ?? null} />
              </>
            ) : (
              <p className="text-sm text-gray-400">No active training.</p>
            )}
          </div>

          {/* Assigned teachers */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Assigned Teachers</h2>
            {assignedTeachers.length === 0 ? (
              <p className="text-sm text-gray-400">No teachers assigned.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {assignedTeachers.map((t) => (
                  <span
                    key={t.id}
                    className="px-3 py-1 rounded-full text-sm font-medium bg-orange-50 text-orange-700"
                  >
                    {t.full_name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Teacher notes */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-2">
            <h2 className="font-semibold text-gray-800">Teacher Notes</h2>
            <p className="text-sm text-gray-600">
              {(student.teacher_notes as string) || 'No teacher notes.'}
            </p>
            <p className="text-xs text-gray-400">Visible to assigned teachers. Not visible to student.</p>
          </div>

          {/* Admin notes */}
          <div className="rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              🔒 Admin Notes — Not visible to teacher or student
            </h2>
            <p className="text-sm" style={{ color: '#78350f' }}>
              {(student.admin_notes as string) || 'No admin notes.'}
            </p>
          </div>

          {/* Password override — admin only, full width */}
          <div className="col-span-2 rounded-xl border p-5 space-y-3"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              🔑 Set New Password — Admin only
            </h2>
            <p className="text-xs" style={{ color: '#78350f' }}>
              Overrides the student&apos;s current password immediately. The student is not notified.
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
        </div>
      )}

      {/* ── Classes ── */}
      {activeTab === 'classes' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Teacher</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date & Time</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {lessons.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-10 text-gray-400">No classes yet.</td>
                </tr>
              ) : (
                lessons.map((lesson) => (
                  <tr key={lesson.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 text-gray-800">{lesson.teacher_name}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(lesson.scheduled_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
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

      {/* ── Hours Log ── */}
      {activeTab === 'hours' && (
        <div className="space-y-4">
          {/* Add / Remove buttons */}
          <div className="flex gap-3">
            <button
              onClick={() => setHoursAction(hoursAction === 'add' ? null : 'add')}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#16a34a' }}
            >
              + Add Hours
            </button>
            <button
              onClick={() => setHoursAction(hoursAction === 'remove' ? null : 'remove')}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50"
            >
              − Remove Hours
            </button>
          </div>

          {/* Inline add/remove form */}
          {hoursAction && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
              <h3 className="font-semibold text-gray-800">
                {hoursAction === 'add' ? 'Add Hours' : 'Remove Hours'}
              </h3>

              {hoursError && (
                <div className="px-4 py-3 rounded-lg text-sm"
                  style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
                  {hoursError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Hours
                  </label>
                  <input
                    type="number" min="0.5" step="0.5"
                    className={inputClass}
                    value={hoursAmount}
                    onChange={(e) => setHoursAmount(e.target.value)}
                    placeholder="e.g. 10"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Invoice Reference
                    {hoursAction === 'remove' && (
                      <span className="ml-1 text-gray-400 font-normal">(optional)</span>
                    )}
                  </label>
                  <input
                    className={inputClass}
                    value={invoiceRef}
                    onChange={(e) => setInvoiceRef(e.target.value)}
                    placeholder="e.g. INV-2026-001"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes
                  {hoursAction === 'remove' && (
                    <span className="ml-1 text-red-500 text-xs">Required</span>
                  )}
                </label>
                <textarea
                  rows={3}
                  className={inputClass}
                  value={hoursNotes}
                  onChange={(e) => setHoursNotes(e.target.value)}
                  placeholder={
                    hoursAction === 'add'
                      ? 'e.g. Payment received 7 Apr 2026 via bank transfer'
                      : 'Required — reason for removing hours'
                  }
                />
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setHoursAction(null); setHoursError(null) }}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleHoursSubmit}
                  disabled={hoursSaving}
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: hoursAction === 'add' ? '#16a34a' : '#dc2626' }}
                >
                  {hoursSaving
                    ? 'Saving...'
                    : hoursAction === 'add'
                    ? 'Confirm & Add'
                    : 'Confirm & Remove'}
                </button>
              </div>
            </div>
          )}

          {/* Hours log table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Balance After</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Reference</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Notes</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                </tr>
              </thead>
              <tbody>
                {hoursLog.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-gray-400">
                      No hours transactions yet.
                    </td>
                  </tr>
                ) : (
                  hoursLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-gray-50">
                      <td className="px-4 py-3">
                        <HoursTypeBadge type={entry.type} />
                      </td>
                      <td className="px-4 py-3 font-medium"
                        style={{ color: entry.amount_hours > 0 ? '#16a34a' : '#dc2626' }}>
                        {entry.amount_hours > 0 ? '+' : ''}{entry.amount_hours}h
                      </td>
                      <td className="px-4 py-3 text-gray-700">{entry.balance_after}h</td>
                      <td className="px-4 py-3 text-gray-500">{entry.invoice_reference || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 max-w-xs truncate">{entry.notes || '—'}</td>
                      <td className="px-4 py-3 text-gray-500">
                        {new Date(entry.created_at).toLocaleDateString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Reports ── */}
      {activeTab === 'reports' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Class Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Teacher</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Class Taken</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Feedback</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-gray-400">No reports yet.</td>
                </tr>
              ) : (
                reports.map((report) => (
                  <tr key={report.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 text-gray-700">
                      {report.lesson_scheduled_at
                        ? new Date(report.lesson_scheduled_at).toLocaleDateString('en-GB', {
                            day: '2-digit', month: 'short', year: 'numeric',
                          })
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{report.teacher_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium"
                        style={
                          report.happened
                            ? { backgroundColor: '#dcfce7', color: '#166534' }
                            : { backgroundColor: '#fee2e2', color: '#991b1b' }
                        }
                      >
                        {report.happened ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                      {report.feedback || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(report.created_at).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Messages ── */}
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
                <p className="text-sm font-semibold text-gray-700">Teacher conversations</p>
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
                  studentId={id}
                />
              )}
            </div>
          </div>
        )
      )}

      {/* ── Reviews ── */}
      {activeTab === 'reviews' && (
        <div className="space-y-4">
          {reviews.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
              <p className="text-gray-400 text-sm">No reviews submitted yet.</p>
            </div>
          ) : (
            reviews.map((review) => (
              <div key={review.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{review.teacher_name}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(review.submitted_at).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                      })}
                    </p>
                  </div>
                  <StarRating rating={review.rating} />
                </div>
                <p className="text-sm text-gray-700 mt-2">
                  {review.admin_edited_text || review.review_text || 'No written review.'}
                </p>
                {review.moderated_by_admin && (
                  <span className="text-xs text-gray-400 mt-1 block">
                    Edited by admin
                  </span>
                )}
              </div>
            ))
          )}
        </div>
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
                {archiving ? 'Archiving...' : 'Archive Student'}
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
              This will permanently delete all classes, hours, messages, reports, reviews, and the account itself.
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
