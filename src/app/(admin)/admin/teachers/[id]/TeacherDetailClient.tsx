'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import SafeHtml from '@/components/SafeHtml'
import { EmailBounceNotice } from '@/components/EmailBounceBadge'
import TasksMini from '@/components/admin/TasksMini'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'

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

// ─── "At a glance" types (exported so page.tsx can import) ───────────────────

/**
 * When this account last authenticated, as three distinct states. 'never' and
 * 'unavailable' are deliberately NOT collapsed: 'never' is a fact about an account
 * that exists and has never been signed in to, while 'unavailable' means the lookup
 * could not run at all (the auth read failed or threw). Rendering the second as the
 * first would state something the page cannot prove.
 *
 * Declared here rather than imported from the admin STUDENT detail client, which
 * carries an identical union: those are two separate route folders, and a
 * cross-page import would tie this page's types to the other page's refactors.
 */
export type TeacherAtAGlanceLastSignIn =
  | { state: 'known'; at: string }
  | { state: 'never' }
  | { state: 'unavailable' }

/**
 * ADMIN-ONLY summary for the Overview tab. Every field is computed on the SERVER at
 * render — this component renders those values and never recounts, re-derives or
 * re-times one, which is what keeps the SSR markup and the first browser render
 * identical.
 *
 * The three counts each come from their own `count: 'exact', head: true` query and
 * NOT from the `lessons` prop: that list is capped at 50 rows, so anything tallied
 * off it would freeze at 50 the moment a teacher passes 50 classes.
 */
export type TeacherAtAGlance = {
  /** profiles.created_at. */
  signedUpAt: string | null
  lastSignIn: TeacherAtAGlanceLastSignIn
  /**
   * Lessons with status 'completed' or 'missed'. 'missed' means the class happened
   * and the report deadline was blown — it zeroes teacher PAY, it does not undo the
   * teaching, so it counts here. null means the count query FAILED: the tile renders
   * '—' and never 0, because 0 would claim a clean record nobody read.
   */
  classesTaught: number | null
  /** null = count query failed; renders '—', never 0. */
  studentNoShows: number | null
  /** null = count query failed; renders '—', never 0. */
  teacherNoShows: number | null
  /**
   * Billable minutes / 60 for the current month in the TEACHER's timezone, summed
   * through getBillability exactly as recomputeInvoiceAmountsForTeacher sums money
   * over the same rows. null when the teacher has no timezone (billing months are
   * teacher-local, so there is nothing honest to show) or the query failed — the
   * tile renders "Unavailable".
   */
  hoursThisMonth: number | null
}

// ─── Domain types ─────────────────────────────────────────────────────────────

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

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_by: string | null
  rescheduled_by: string | null
  student_name: string
}

type Invoice = {
  id: string
  billing_month: string
  amount_eur: number | null
  status: string | null
  created_at: string
}

// billing_month is a DATE-only value ('YYYY-MM-01' — its only producer is getMonthKeyInTz
// via the teacher billing page), not an instant, so it is formatted in UTC and deliberately
// NOT in the admin's zone: the T12:00:00Z construction already pins the calendar month, and
// re-projecting it through a viewer zone would be a second, needless shift. Without an
// explicit timeZone this read the HOST zone on the server and the VIEWER zone in the browser
// — a hydration mismatch even in the cases where the two happened to agree on the month.
function formatMonth(dateStr: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long', year: 'numeric',
  }).format(new Date(dateStr + 'T12:00:00Z'))
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
  adminTz: string
  teacherAtAGlance: TeacherAtAGlance
  /** True when the classes read came back exactly at its 1000-row cap, so older
   *  classes exist beyond it. Drives the disclosure line above the Classes table. */
  lessonsCapped: boolean
}

type Tab = 'overview' | 'classes' | 'invoices' | 'history' | 'messages'

// ─── Small reusable components ────────────────────────────────────────────────

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
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={colour}>
      {STATUS_LABEL[status ?? ''] ?? status ?? '—'}
    </span>
  )
}

function LessonStatusBadge({ status, cancelled_by, rescheduled_by }: { status: string; cancelled_by?: string | null; rescheduled_by?: string | null }) {
  const meta: Record<string, { bg: string; color: string; label: string }> = {
    completed: { bg: '#DCFCE7', color: '#15803D', label: 'Completed' },
    scheduled: { bg: '#dbeafe', color: '#1e40af', label: 'Scheduled' },
    cancelled: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled' },
    cancelled_by_student: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled by student' },
    cancelled_by_teacher: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled by teacher' },
    student_no_show: { bg: '#FFF8E8', color: '#B45309', label: 'Student no show' },
    teacher_no_show: { bg: '#FFEEE6', color: '#FD5602', label: 'Teacher no show' },
  }
  const entry = meta[status] ?? { bg: '#f3f4f6', color: '#6b7280', label: status.replace(/_/g, ' ') }
  // Colour keys off status (via meta); the label gets cancellation/reschedule
  // attribution from the shared helper when the row is in the cancelled family.
  const label = getCancellationLabel({ status, cancelled_by, rescheduled_by }, 'admin') ?? entry.label

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ backgroundColor: entry.bg, color: entry.color }}
    >
      {label}
    </span>
  )
}

// Mirrors getInvoiceStatusColor in the admin billing client. Status strings come
// from public.invoices.status: 'pending' | 'uploaded' | 'paid' | 'overdue'
// (the admin billing filter's option set); 'late' is carried as a red alias.
function invoiceStatusStyle(status: string | null): { bg: string; text: string } {
  switch (status) {
    case 'paid': return { bg: '#DCFCE7', text: '#15803D' }
    case 'uploaded': return { bg: '#EFF6FF', text: '#3B82F6' }
    case 'pending': return { bg: '#FFF8E8', text: '#B45309' }
    case 'overdue':
    case 'late': return { bg: '#FFEEE6', text: '#FD5602' }
    default: return { bg: '#f3f4f6', text: '#6b7280' }
  }
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
            style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}>
            Admin only
          </span>
        )}
      </span>
      <span className="text-sm text-gray-800">{value || '—'}</span>
    </div>
  )
}

/**
 * One "At a glance" tile. Renders a value the SERVER computed and nothing else — no
 * count, no date arithmetic and no clock read happens in here.
 *
 * A tile with an onClick is a real <button> that switches tabs; a tile without one is
 * a plain div, never a disabled button. "Signed up" and "Last sign-in" have nowhere to
 * lead, and a dead button invites the click anyway.
 *
 * Numbers render large and text (a date, "Never signed in") one step smaller so it
 * fits a quarter-width tile without wrapping. Both class strings are written out in
 * full — Tailwind v4 never sees a constructed class name.
 *
 * DELIBERATE COPY of the identical component in the admin STUDENT detail client, not
 * an import: the admin pages currently share no component directory, and consolidating
 * the two is tracked with the avatar-component item. Kept byte-identical so that
 * consolidation stays a straight de-dup. The onClick variant is therefore carried over
 * but is UNUSED on this page — all six tiles here are plain. The Classes tab on this
 * page has no status filter to land on, and a click that goes nowhere is worse than a
 * tile that never offered one.
 */
function GlanceTile({
  label,
  value,
  caption,
  onClick,
}: {
  label: string
  value: string | number
  caption?: string
  onClick?: () => void
}) {
  const body = (
    <>
      <p className="text-xs font-medium" style={{ color: '#4b5563' }}>{label}</p>
      <p
        className={
          typeof value === 'number'
            ? 'text-2xl font-semibold text-gray-900 mt-1'
            : 'text-base font-semibold text-gray-900 mt-1'
        }
      >
        {value}
      </p>
      {caption && (
        <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{caption}</p>
      )}
    </>
  )

  if (!onClick) {
    return <div className="rounded-xl border border-gray-100 bg-white p-4">{body}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-gray-100 bg-white p-4 text-left cursor-pointer transition-colors hover:bg-gray-50"
    >
      {body}
    </button>
  )
}

// ─── Messages helpers ─────────────────────────────────────────────────────────

// Wall-clock parts of an instant in an explicit timezone. Intl with a timeZone is
// deterministic: the same output on server and client, so it is safe in this client
// component under SSR. The Date getters this replaces (getFullYear/getMonth/getDate/
// getHours/getMinutes) read the HOST zone on the server and the VIEWER zone in the browser,
// which both mismatched on hydration and showed the wrong wall-clock time. hourCycle 'h23'
// (not hour12: false) is required: hour12: false yields "24" for midnight under some
// locales, where the getHours() version returned "00".
function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0'
  return {
    year:   Number(get('year')),
    month:  Number(get('month')),  // 1-12
    day:    Number(get('day')),
    hour:   get('hour'),           // already zero-padded '00'-'23'
    minute: get('minute'),         // already zero-padded '00'-'59'
  }
}

// The day-boundary definition in this file: an instant's calendar date in `timezone`, as a
// UTC-midnight stamp. The in-thread date separators group on it, replacing toDateString()
// (browser-local on the client, host-local on the server).
function zonedDayStamp(date: Date, timezone: string): number {
  const p = zonedParts(date, timezone)
  return Date.UTC(p.year, p.month - 1, p.day)
}

// Relative timestamp for the conversation list and the message rows. diffDays stays an
// elapsed-milliseconds floor: it reads no zone at all, so preserving it keeps the
// today/Yesterday/weekday/date thresholds exactly where they were. Only the rendered parts
// were zone-dependent — getHours/getMinutes read the host zone on the server and the viewer
// zone in the browser, and toLocaleDateString([], …) followed the browser's zone AND its
// locale, so the same message rendered differently for different viewers. The locale is now
// pinned to en-GB, which is the form the en-GB rendering already produced ("29 Jul").
function msgFormatTime(dateStr: string, timezone: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    const p = zonedParts(date, timezone)
    return `${p.hour}:${p.minute}`
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short',
    }).format(date)
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, day: 'numeric', month: 'short',
  }).format(date)
}

// In-thread date separator ("Wednesday 29 July"), in the admin's timezone. The locale is
// pinned to en-GB rather than left to the viewer: toLocaleDateString([], …) followed the
// browser's locale AND the browser's zone, so the same thread rendered a different label
// (and, near midnight, a different day) depending on who was looking at it.
function formatSeparatorDate(dateStr: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(dateStr))
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
  timezone,
}: {
  conversation: AdminConversation
  teacherId: string
  timezone: string
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
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 thin-scroll">
        <style>{`
          .admin-msg-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
          .admin-msg-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
          .admin-msg-bubble li { margin: 0.1rem 0; }
        `}</style>
        {conversation.messages.map((msg, index) => {
          const isFromTeacher = msg.sender_id === teacherId
          const showDate =
            index === 0 ||
            zonedDayStamp(new Date(msg.created_at), timezone) !==
              zonedDayStamp(new Date(conversation.messages[index - 1].created_at), timezone)

          return (
            <div key={msg.id}>
              {showDate && (
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {formatSeparatorDate(msg.created_at, timezone)}
                  </span>
                  <div className="flex-1 h-px bg-gray-100" />
                </div>
              )}
              <div className={`flex ${isFromTeacher ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[72%]">
                  <SafeHtml
                    className="admin-msg-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                    style={
                      isFromTeacher
                        ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                        : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                    }
                    html={msg.content}
                  />
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-1 flex flex-col gap-1">
                      {msg.attachments.map((att, i) => (
                        <a
                          key={i}
                          href={messageAttachmentHref('message', msg.id, i, att.url)}
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
                    <span className="text-xs text-gray-400">{msgFormatTime(msg.created_at, timezone)}</span>
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

export default function TeacherDetailClient({ teacher, lessons, invoices, history, conversations, purgeBlockedBy, adminTz, teacherAtAGlance, lessonsCapped }: Props) {
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
  const [showPassword, setShowPassword] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  const id = teacher.id as string
  const fullName = (teacher.full_name as string | null) || (teacher.email as string | null) || 'this account'
  const photoUrl = teacher.photo_url as string | null
  const status = teacher.status as string | null
  const accountTypes = (teacher.account_types as string[]) ?? []

  const currencySymbol = teacher.currency === 'USD' ? '$' : teacher.currency === 'GBP' ? '£' : '€'

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
        body: JSON.stringify({ status: 'former' }),
      })
      if (!res.ok) throw new Error('Failed to archive teacher.')
      setShowArchiveDialog(false)
      router.push('/admin/teachers')
      router.refresh()
    } catch {
      setArchiveError('Something went wrong. Please try again.')
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
      if (!res.ok) {
        const blocking = Array.isArray(data.blocking)
          ? (data.blocking as { table: string; count: number }[])
          : []
        if (blocking.length > 0) {
          const detail = blocking.map((b) => `${b.table}: ${b.count}`).join(', ')
          throw new Error(
            `${data.error || 'Cannot purge: this teacher has history. Archive instead.'} Blocking records — ${detail}.`
          )
        }
        throw new Error(data.error || 'Failed to purge teacher.')
      }
      setShowPurgeDialog(false)
      router.push('/admin/teachers')
      router.refresh()
    } catch (err: unknown) {
      setPurgeError(err instanceof Error ? err.message : 'Something went wrong.')
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

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'classes', label: 'Classes', count: lessons.length },
    { key: 'invoices', label: 'Invoices', count: invoices.length },
    { key: 'history', label: 'History' },
    { key: 'messages', label: 'Messages', count: conversations.length },
  ]

  return (
    <div className="p-6">
      {/* Back */}
      <button
        onClick={() => router.push('/admin/teachers')}
        className="text-sm text-gray-500 hover:text-gray-700 mb-4 block"
      >
        ← Teachers
      </button>

      {/* Top card */}
      <div className="card-elevated p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          {/* Left: photo + name */}
          <div className="flex items-center gap-4">
            {photoUrl ? (
              <img src={photoUrl} alt={fullName}
                className="w-[72px] h-[72px] rounded-full object-cover" />
            ) : (
              <div className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-white text-xl font-bold"
                style={{ backgroundColor: '#FF8303' }}>
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500 mb-2">{teacher.email as string}</p>
              {teacher.email_bounced_at ? (
                <EmailBounceNotice reason={teacher.email_bounce_reason as string | null} />
              ) : null}
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
                onClick={() => router.push(`/admin/teachers/${id}/schedule`)}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Schedule
              </button>
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
            {tab.count !== undefined && (
              <span
                style={{
                  padding: '2px 7px',
                  borderRadius: 9999,
                  fontSize: '11px',
                  fontWeight: 600,
                  marginLeft: '6px',
                  ...(activeTab === tab.key
                    ? { backgroundColor: 'rgba(255,255,255,0.25)', color: '#ffffff' }
                    : { backgroundColor: '#F3F4F6', color: '#6b7280' }),
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* At a glance — every number and both dates were computed on the SERVER
              at render. Nothing below reads a clock, recounts anything or re-derives a
              total, which is what keeps the SSR markup and the first browser render
              identical.

              Rendered full width ABOVE the existing three-column grid; that grid, and
              every card in it, is untouched. */}
          <div className="card-elevated p-5">
            <h2 className="font-semibold text-gray-800 mb-4">At a glance</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <GlanceTile
                label="Signed up"
                value={
                  teacherAtAGlance.signedUpAt
                    ? new Date(teacherAtAGlance.signedUpAt).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: adminTz,
                      })
                    : '—'
                }
              />
              <GlanceTile
                label="Last sign-in"
                value={
                  teacherAtAGlance.lastSignIn.state === 'known'
                    ? new Date(teacherAtAGlance.lastSignIn.at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                        timeZone: adminTz,
                      })
                    : teacherAtAGlance.lastSignIn.state === 'never'
                    ? 'Never signed in'
                    : 'Unavailable'
                }
                caption="Stamped at sign-in, not on every visit."
              />
              {/* Each count came from its OWN head-count query, so none of the three
                  inherits the 50-row cap on the list behind the Classes tab. null means
                  that query FAILED and the tile shows '—' — never 0, which would report a
                  clean record the page never actually read. */}
              <GlanceTile
                label="Classes taught"
                value={teacherAtAGlance.classesTaught ?? '—'}
                caption="Includes classes with a blown report deadline."
              />
              <GlanceTile label="Student no-shows" value={teacherAtAGlance.studentNoShows ?? '—'} />
              <GlanceTile label="Teacher no-shows" value={teacherAtAGlance.teacherNoShows ?? '—'} />
              {/* Summed on the server through getBillability over the teacher-local
                  month. Rendered in the same shape as the student panel's hours strings,
                  so it lands on GlanceTile's string branch. */}
              <GlanceTile
                label="Hours this month"
                value={
                  teacherAtAGlance.hoursThisMonth !== null
                    ? `${teacherAtAGlance.hoursThisMonth % 1 === 0 ? teacherAtAGlance.hoursThisMonth : teacherAtAGlance.hoursThisMonth.toFixed(1)}h`
                    : 'Unavailable'
                }
                caption="Billable, month to date."
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            {/* Personal info */}
            <div className="card-elevated p-5 space-y-4">
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
            <div className="card-elevated p-5 space-y-4">
              <h2 className="font-semibold text-gray-800">Professional</h2>
              <InfoRow label="Teaching Languages"
                value={(teacher.teaching_languages as string[] | null)?.join(', ')} />
              <InfoRow label="Native Languages"
                value={(teacher.native_languages as string[] | null)?.join(', ')} />
              <InfoRow label="Specialties" value={teacher.specialties as string} />
              <InfoRow label="Contract Start" value={teacher.contract_start as string} />
              <InfoRow label="Orientation Date" value={teacher.orientation_date as string} />
              <InfoRow label="Observed Lesson Date" value={teacher.observed_lesson_date as string} />
              <InfoRow label="Hourly Rate"
                value={teacher.hourly_rate != null ? `${currencySymbol}${parseFloat(Number(teacher.hourly_rate).toFixed(2)).toString()}` : null}
                adminOnly />
              <InfoRow label="VAT Required"
                value={teacher.vat_required ? 'Yes' : 'No'}
                adminOnly />
            </div>

            {/* Payment info */}
            <div className="card-elevated p-5 space-y-4">
              <h2 className="font-semibold text-gray-800">Payment Details</h2>
              <InfoRow label="Preferred Payment" value={teacher.preferred_payment_type === "bank" ? "Bank Transfer" : teacher.preferred_payment_type === "paypal" ? "PayPal" : teacher.preferred_payment_type as string} />
              <InfoRow label="PayPal Email" value={teacher.paypal_email as string} />
              <InfoRow label="IBAN" value={teacher.iban as string} />
              <InfoRow label="SWIFT / BIC" value={teacher.bic as string} />
              <InfoRow label="Tax Number" value={teacher.tax_number as string} />
            </div>

            {/* Follow-up */}
            <div className="card-elevated p-5 space-y-4">
              <h2 className="font-semibold text-gray-800">Follow-up</h2>
              <InfoRow label="Follow-up Date"
                value={teacher.follow_up_date as string} adminOnly />
              <InfoRow label="Follow-up Reason"
                value={teacher.follow_up_reason as string} adminOnly />
            </div>

            {/* Admin notes — full width, amber background */}
            <div className="col-span-3 rounded-xl border p-5 space-y-2"
              style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
              <h2 className="font-semibold" style={{ color: '#92400e' }}>
                🔒 Admin Notes — Not visible to teacher
              </h2>
              <p className="text-sm" style={{ color: '#78350f' }}>
                {(teacher.admin_notes as string) || 'No admin notes.'}
              </p>
            </div>

            {/* Password override — admin only */}
            <div className="col-span-3 rounded-xl border p-5 space-y-3"
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
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => { setNewPassword(e.target.value); setPasswordSuccess(false); setPasswordError(null) }}
                      placeholder="Min. 8 characters"
                      className="w-full border rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none"
                      style={{ borderColor: '#fde68a', backgroundColor: 'white' }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
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
              <div className="col-span-3 card-elevated p-5 space-y-2">
                <h2 className="font-semibold text-gray-800">Bio</h2>
                <p className="text-sm text-gray-600">{teacher.bio as string}</p>
              </div>
            )}

            {/* Open tasks linked to this teacher. TasksMini renders its own header,
                so this wrapper supplies only the full-width card the other overview
                sections use. linkedId is profiles.id, which is what tasks.linked_entity_id
                holds for linked_entity_type 'teacher' (the TaskForm teacher dropdown is
                fed by /api/admin/teachers?minimal=true, i.e. profiles rows). */}
            <div className="col-span-3 card-elevated p-5">
              <TasksMini
                linkedType="teacher"
                linkedId={id}
                linkedName={fullName}
                adminTz={adminTz}
              />
            </div>
          </div>
        </div>
      )}

      {/* Classes tab */}
      {activeTab === 'classes' && (
        <div className="space-y-2">
          {lessonsCapped && (
            <p className="text-sm text-gray-400">Showing the most recent 1000 classes.</p>
          )}
          <div className="card-elevated overflow-hidden">
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
                          timeZone: adminTz,
                        })}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{lesson.duration_minutes} min</td>
                      <td className="px-4 py-3">
                        <LessonStatusBadge status={lesson.status} cancelled_by={lesson.cancelled_by} rescheduled_by={lesson.rescheduled_by} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Invoices tab */}
      {activeTab === 'invoices' && (
        <div className="card-elevated overflow-hidden">
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
                    <td className="px-4 py-3 text-gray-800">{formatMonth(inv.billing_month)}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {inv.amount_eur != null ? `${currencySymbol}${Number(inv.amount_eur).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                        style={{ backgroundColor: invoiceStatusStyle(inv.status).bg, color: invoiceStatusStyle(inv.status).text }}
                      >
                        {inv.status ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(inv.created_at).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        timeZone: adminTz,
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
        <div className="card-elevated overflow-hidden">
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
                        timeZone: adminTz,
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
          <div className="card-elevated p-8 text-center">
            <p className="text-gray-400 text-sm">No conversations yet.</p>
          </div>
        ) : (
          <div
            className="flex card-elevated overflow-hidden"
            style={{ height: '620px' }}
          >
            {/* Left: conversation list */}
            <div className="w-64 border-r border-gray-200 flex flex-col flex-shrink-0">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-700">Student conversations</p>
              </div>
              <div className="flex-1 overflow-y-auto thin-scroll">
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
                              {msgFormatTime(lastMsg.created_at, adminTz)}
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
                  timezone={adminTz}
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
              This permanently deletes the account and its login. Purging is only possible for
              accounts with no history — a teacher with any classes, invoices, messages, or other
              records must be archived instead.
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
