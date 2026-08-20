'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { sanitizeHtml } from '@/lib/sanitize'
import { EmailBounceNotice } from '@/components/EmailBounceBadge'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { checkAllowedDuration } from '@/lib/lessons/allowedDurations'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'
import TasksMini from '@/components/admin/TasksMini'
import { DatePartInput } from '../../_components/DatePartInput'
import { DateRangeFilter, matchDateRangePreset, isDateRangePreset } from '../../_components/DateRangeFilter'
import AssignMaterialHomeworkModal from './AssignMaterialHomeworkModal'
import { categoryBadgeStyle } from '@/lib/study/categoryBadge'
import { useFilterPersistence } from '@/lib/hooks/useFilterPersistence'
import { getPresetRange, type DateRangePreset } from '@/lib/dates/dateRangePresets'

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

export type Assignment = {
  id: string
  assigned_at: string
  lesson_id: string | null
  study_sheet: {
    title: string
    category: string | null
    level: string | null
  }
}

/**
 * One teaching-material homework grant (a material_assignments row), live OR
 * revoked. Revoke is semantic — revoked_at is stamped and the row is kept as the
 * audit trail of what was handed out — so both states render here.
 *
 * `sheet_title` is null when the sheet title could not be read; the granted
 * filename on the row is the fallback and is always present.
 */
export type MaterialHomework = {
  id: string
  sheet_title: string | null
  attachment_name: string
  page_start: number | null
  page_end: number | null
  assigned_at: string
  revoked_at: string | null
}

export type MaterialAttachment = { name: string; type: string }

/** One assignable teaching material: active, audience='staff'. */
export type MaterialSheetOption = {
  id: string
  title: string
  attachments: MaterialAttachment[]
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
  cancelled_by: string | null
  rescheduled_by: string | null
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
  status: string
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
  /**
   * STRICT `status === 'active'` over ALL of the student's trainings. NOT
   * `activeTrain !== null` — activeTrain deliberately falls back to the newest
   * training of any status so the Training card still shows something once a
   * package has ended. Everything that WRITES (Create Training, Add/Remove
   * Hours) gates on this flag instead.
   */
  hasActiveTraining: boolean
  /**
   * Assignable teachers for the Create Training form: role teacher/admin,
   * status 'current' — the same set the POST route re-validates against. Empty
   * for staff viewers and whenever an active training already exists, because
   * the form does not render in either case.
   */
  teacherOptions: Teacher[]
  /**
   * True when the assignable-teacher read failed. An empty picker is
   * indistinguishable from "no teachers exist", so the form says so rather than
   * letting an admin create a training with nobody attached by accident.
   */
  teacherOptionsLoadFailed: boolean
  hoursRemaining: number | null
  assignedTeachers: Teacher[]
  lessons: Lesson[]
  /**
   * True when the lessons read came back exactly at its 1000-row cap, so older
   * classes exist beyond what this tab holds. Surfaced as a disclosure line: an
   * unstated cap makes a truncated Classes list read as the student's whole history.
   */
  lessonsCapped: boolean
  hoursLog: HoursLogEntry[]
  reports: Report[]
  /** Same cap disclosure for the reports read — see lessonsCapped. */
  reportsCapped: boolean
  reviews: Review[]
  conversations: AdminConversation[]
  purgeBlockedBy: string[]
  /**
   * True when the server-side purge advisory pre-check could not complete (a
   * query errored). Eligibility is unproven, so the purge control fails CLOSED
   * rather than treating an empty purgeBlockedBy as "nothing is blocking".
   */
  purgePreflightFailed: boolean
  assignments: Assignment[]
  /** Teaching-material homework grants for this student, live AND revoked, newest first. */
  materialHomework: MaterialHomework[]
  /**
   * True when the material_assignments read failed. An empty list is
   * indistinguishable from a failed read, so the section shows the reason
   * instead of claiming this student has no homework.
   */
  materialHomeworkLoadFailed: boolean
  /** Assignable teaching material (active, audience='staff') for the assign modal. */
  materialSheets: MaterialSheetOption[]
  /**
   * True when the teaching-material list failed to load. Same hazard as above:
   * an empty picker would otherwise read as "there is none".
   */
  materialSheetsLoadFailed: boolean
  /** Staff (non-admin) get a read-only Overview + Classes view with admin-only fields hidden. */
  isStaffView?: boolean
  /** IANA zone of the viewing admin/staff account. Every rendered instant is projected through it. */
  adminTz: string
  /**
   * The SAME profiles.timezone column, kept raw: null when the viewing account has no
   * zone set. Presets-only - it feeds the Hours Log quick-range buttons, which go dead
   * on null rather than resolving "this month" in UTC and naming the wrong calendar
   * month. adminTz above keeps the 'UTC' display fallback and is NOT interchangeable
   * with this one: a fallback that is survivable for formatting is not survivable for
   * deciding which day "today" is.
   */
  adminTzRaw: string | null
}

type Tab = 'overview' | 'classes' | 'hours' | 'reports' | 'assignments' | 'messages' | 'reviews'

// ── Small reusable components ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  const colour =
    status === 'current'
      ? { backgroundColor: '#DCFCE7', color: '#15803D' }
      : status === 'former'
      ? { backgroundColor: '#f3f4f6', color: '#6b7280' }
      : status === 'on_hold'
      ? { backgroundColor: '#FFF8E8', color: '#B45309' }
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

/**
 * Read-only marker for a SCHEDULED lesson whose duration is not one this student is
 * allowed to book. Renders nothing at all when there is nothing to say.
 *
 * INFORMATIONAL. Admin booking is deliberately exempt from the per-student duration
 * rule, so a marked row is not an error: nothing here blocks, writes, or is clickable.
 *
 * Two deliberate non-behaviours:
 *  - 'unknown' RENDERS (as "?"). It means the allowed list could not be read - the
 *    staff-view column list on this page is one place it could go missing - and that
 *    must never look the same as "this duration is fine". See checkAllowedDuration.
 *  - No clock is read. Status alone decides, so this is render-pure and identical on
 *    server and client; a past-but-still-'scheduled' row keeps its marker, which is
 *    correct - the row still claims the class is going ahead.
 *
 * `allowed` stays `unknown` end to end: it comes off the `student` prop, which is a
 * Record<string, unknown>, and the narrowing belongs in the helper, not in a cast here.
 */
function DurationMarker({
  status,
  durationMinutes,
  allowed,
}: {
  status: string
  durationMinutes: number
  allowed: unknown
}) {
  if (status !== 'scheduled') return null

  const result = checkAllowedDuration(allowed, durationMinutes)
  if (result.state === 'ok') return null

  const label =
    result.state === 'not_allowed'
      ? `${durationMinutes} min is not in this student's allowed durations (${result.durations.join(', ')})`
      : "This student's allowed durations could not be read"
  const colour =
    result.state === 'not_allowed'
      ? { backgroundColor: '#FFF8E8', color: '#B45309' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }

  return (
    <span
      title={label}
      aria-label={label}
      className="ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-xs font-medium"
      style={colour}
    >
      {result.state === 'not_allowed' ? '!' : '?'}
    </span>
  )
}

function HoursTypeBadge({ type }: { type: string }) {
  const colour =
    type === 'add'
      ? { backgroundColor: '#DCFCE7', color: '#15803D' }
      : type === 'deduct' || type === 'class_booking' || type === 'teacher_no_show_clawback'
      ? { backgroundColor: '#FFEEE6', color: '#FD5602' }
      : type === 'cancellation_refund' || type === 'teacher_no_show_refund'
      ? { backgroundColor: '#dbeafe', color: '#1e40af' }
      : { backgroundColor: '#f3f4f6', color: '#6b7280' }
  const label: Record<string, string> = {
    add: 'Add',
    deduct: 'Deduct',
    class_booking: 'Class Booking',
    cancellation_refund: 'Cancellation Refund',
    admin_adjustment: 'Admin Adjustment',
    reschedule: 'Rescheduled',
    duration_change: 'Duration Changed',
    reschedule_reversal: 'Reschedule Reversed',
    booking_reversal: 'Booking Reversed',
    teacher_no_show_refund: 'Teacher No-Show Refund',
    teacher_no_show_clawback: 'No-Show Refund Reversed',
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={colour}>
      {label[type] ?? type}
    </span>
  )
}

function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null
  const style = categoryBadgeStyle(category ? category.toLowerCase() : null)
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium capitalize" style={style}>
      {category}
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
            style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}>
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

// ─── Hours Log date filter ───────────────────────────────

// Deliberately SHARED across students, not keyed per student. The month-end workflow
// is "set Last month once, then walk student to student", so carrying the choice from
// one record to the next is the point rather than a leak - and a stored preset is
// recomputed against now on restore, so it can never carry a stale month with it.
// sessionStorage keeps the whole thing scoped to one browsing session.
const HOURS_FILTERS_STORAGE_KEY = 'll-admin-student-hours-filters'

/**
 * What the Hours Log tab remembers for the rest of the browsing session.
 *
 * EITHER a preset id OR concrete day keys, never both:
 *
 *   preset !== null  -> from/to are '' and the range is RECOMPUTED from the current
 *                       clock on restore. "Last month" must still mean last month
 *                       after midnight on the 1st; storing its dates would pin the
 *                       filter to a month that has since passed.
 *   preset === null  -> a hand-typed custom range, stored as the literal day keys.
 *                       An explicitly chosen date means that date and nothing else.
 */
type HoursStoredFilters = {
  preset: DateRangePreset | null
  from: string
  to: string
}

const DEFAULT_HOURS_STORED_FILTERS: HoursStoredFilters = {
  preset: null,
  from: '',
  to: '',
}

// An instant's calendar day in `timezone` as a 'YYYY-MM-DD' key, built on the
// zonedParts probe above. Rows are bucketed in the SAME zone the Date column renders
// them in (adminTz), so a row displayed as 01 Aug can never be excluded from an August
// filter by a zone mismatch - one Intl read decides both what is shown and what is
// matched. No ISO round trip anywhere: an ISO UTC string names the UTC day, which is a
// different day for any zone whose offset pushes the instant across midnight.
function zonedDayKey(dateStr: string, timezone: string): string {
  const p = zonedParts(new Date(dateStr), timezone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// ─── Classes date filter ──────────────────────────

// Shared across students under one key - the same deliberate convention as the Hours
// Log filter above. The reconciliation workflow is "set a month once, then walk student
// to student", so carrying the range from one record to the next is the point rather
// than a leak, and a stored preset is recomputed against now on restore so it can never
// carry a stale month with it. sessionStorage scopes the whole thing to one session.
//
// Its OWN key, not the Hours Log one: the two tabs narrow different row sets, and an
// admin who filtered the Classes list has said nothing about which hours transactions
// they want to see. The bucketing helper IS shared - zonedDayKey above serves both.
const CLASSES_FILTERS_STORAGE_KEY = 'll-admin-student-classes-filters'

/**
 * What the Classes tab remembers for the rest of the browsing session.
 *
 * EITHER a preset id OR concrete day keys, never both - the same split the Hours Log
 * record uses, for the same reason:
 *
 *   preset !== null  -> from/to are '' and the range is RECOMPUTED from the current
 *                       clock on restore. "This week" must still mean this week after
 *                       midnight on Monday; storing its dates would pin the filter to
 *                       a week that has since passed.
 *   preset === null  -> a hand-typed custom range, stored as the literal day keys.
 *                       An explicitly chosen date means that date and nothing else.
 */
type ClassesStoredFilters = {
  preset: DateRangePreset | null
  from: string
  to: string
}

const DEFAULT_CLASSES_STORED_FILTERS: ClassesStoredFilters = {
  preset: null,
  from: '',
  to: '',
}

// 'YYYY-MM-DD' or empty. Taken from the admin Classes list, which validates restored day
// keys by SHAPE rather than accepting any string, and stricter than the typeof-only check
// the Hours Log parse does today. A stored value goes straight back into a date input and
// into a lexical >= / <= against real day keys, so a tampered or malformed record has to
// restore as EMPTY: restored verbatim, an arbitrary string would leave the input blank
// while silently excluding every row, showing no filter for the admin to clear.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
function isDayKeyOrEmpty(value: string): boolean {
  return value === '' || DAY_KEY_RE.test(value)
}

// ─── Read-only message thread ─────────────────────────────────────────────────

function MessageThread({
  conversation,
  studentId,
  timezone,
}: {
  conversation: AdminConversation
  studentId: string
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
          <p className="text-xs text-gray-400">Teacher</p>
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
          const isFromStudent = msg.sender_id === studentId
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
              <div className={`flex ${isFromStudent ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[72%]">
                  <div
                    className="admin-msg-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                    style={
                      isFromStudent
                        ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                        : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                    }
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
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
                          style={{ color: isFromStudent ? '#fff' : '#d1d5db' }}
                        >
                          📎 {att.filename}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className={`flex items-center mt-1 ${isFromStudent ? 'justify-end' : 'justify-start'}`}>
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

// ── Main component ────────────────────────────────────────────────────────────

export default function StudentDetailClient({
  student,
  companyName,
  activeTrain,
  hasActiveTraining,
  teacherOptions,
  teacherOptionsLoadFailed,
  hoursRemaining,
  assignedTeachers,
  lessons,
  lessonsCapped,
  hoursLog,
  reports,
  reportsCapped,
  reviews,
  conversations,
  purgeBlockedBy,
  purgePreflightFailed,
  assignments: initialAssignments,
  materialHomework,
  materialHomeworkLoadFailed,
  materialSheets,
  materialSheetsLoadFailed,
  isStaffView = false,
  adminTz,
  adminTzRaw,
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

  // Hours log date filter. Declared at the TOP LEVEL of this component and
  // unconditionally: the tabs below are inline conditional JSX, so anything declared
  // inside one of them would be a hook sitting behind a condition.
  const [hoursFrom, setHoursFrom] = useState('')
  const [hoursTo, setHoursTo] = useState('')

  // The record handed to sessionStorage. Rebuilt every render - these two values are
  // its only inputs - and matchDateRangePreset is the same call that decides which
  // quick-range button DateRangeFilter highlights, so what the row shows as active and
  // what gets stored are one decision. A hand-typed range that happens to equal a
  // preset is therefore stored AS that preset, which is exactly what the row is
  // telling the admin it is.
  const hoursPreset = matchDateRangePreset(hoursFrom, hoursTo, adminTzRaw, new Date())
  const persistedHoursFilters: HoursStoredFilters = {
    preset: hoursPreset,
    from: hoursPreset ? '' : hoursFrom,
    to: hoursPreset ? '' : hoursTo,
  }

  /**
   * Shape validation for a decoded stored record. Returning null rejects the WHOLE
   * record and the tab opens unfiltered: a record written by a different build of this
   * page, or edited by hand, cannot be trusted field by field, and a half-applied
   * filter is worse than no filter.
   */
  function parseStoredHoursFilters(raw: unknown): HoursStoredFilters | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>

    const from = record.from
    const to = record.to
    if (typeof from !== 'string' || typeof to !== 'string') return null
    if (!isDayKeyOrEmpty(from) || !isDayKeyOrEmpty(to)) return null

    let preset: DateRangePreset | null
    if (record.preset === null) preset = null
    else if (isDateRangePreset(record.preset)) preset = record.preset
    else return null

    return {
      preset,
      // Enforces the invariant on the way IN as well as on the way out: with a preset
      // active the stored dates are meaningless and the range comes from the clock.
      from: preset ? '' : from,
      to: preset ? '' : to,
    }
  }

  /**
   * Push a restored record into filter state. Runs once, from the hook's mount effect
   * - never during render, so the clock read below cannot desync server and client
   * markup.
   */
  function applyStoredHoursFilters(stored: HoursStoredFilters) {
    if (stored.preset) {
      // Recomputed against NOW, which is the whole point of storing the id: a session
      // that spans midnight, or a tab returned to later in the day, gets the preset the
      // admin chose rather than the days it covered when they chose it.
      //
      // No timezone means no honest answer to "which day is today" - the same reason
      // DateRangeFilter disables the preset buttons on a null zone. The range restores
      // EMPTY rather than guessing UTC, and the hook then rewrites storage to match
      // what is actually on screen.
      const range = adminTzRaw ? getPresetRange(stored.preset, new Date(), adminTzRaw) : null
      setHoursFrom(range?.from ?? '')
      setHoursTo(range?.to ?? '')
    } else {
      setHoursFrom(stored.from)
      setHoursTo(stored.to)
    }
  }

  // `clear` is deliberately not taken off the return: the hook REMOVES the key by
  // itself the moment the record matches the default, which is the exact end state the
  // Clear button produces. skipRestore is false because no URL filter params reach this
  // tab - there is no deep link a restored range could quietly widen or narrow.
  useFilterPersistence<HoursStoredFilters>({
    storageKey: HOURS_FILTERS_STORAGE_KEY,
    value: persistedHoursFilters,
    defaultValue: DEFAULT_HOURS_STORED_FILTERS,
    skipRestore: false,
    parse: parseStoredHoursFilters,
    apply: applyStoredHoursFilters,
  })

  // Derived per render, never held in state - stored, it would drift out of step the
  // moment either date input changed. Bucketed in adminTz (the DISPLAY zone), not
  // adminTzRaw: the Date column below renders in adminTz, and the filter must agree
  // with what the admin can actually see. Both bounds are inclusive, and lexical
  // comparison is exact on fixed-width 'YYYY-MM-DD' keys.
  const filteredHoursLog = (hoursFrom || hoursTo)
    ? hoursLog.filter((e) => {
        const key = zonedDayKey(e.created_at, adminTz)
        return (!hoursFrom || key >= hoursFrom) && (!hoursTo || key <= hoursTo)
      })
    : hoursLog

  // Classes date filter. Declared at the TOP LEVEL of this component, next to the Hours
  // Log pair above and unconditionally: the tabs below are inline conditional JSX, so
  // anything declared inside one of them would be a hook sitting behind a condition.
  const [classesFrom, setClassesFrom] = useState('')
  const [classesTo, setClassesTo] = useState('')

  // The record handed to sessionStorage. Rebuilt every render - these two values are
  // its only inputs - and matchDateRangePreset is the same call that decides which
  // quick-range button DateRangeFilter highlights, so what the row shows as active and
  // what gets stored are one decision. A hand-typed range that happens to equal a
  // preset is therefore stored AS that preset, which is exactly what the row is
  // telling the admin it is.
  const classesPreset = matchDateRangePreset(classesFrom, classesTo, adminTzRaw, new Date())
  const persistedClassesFilters: ClassesStoredFilters = {
    preset: classesPreset,
    from: classesPreset ? '' : classesFrom,
    to: classesPreset ? '' : classesTo,
  }

  /**
   * Shape validation for a decoded stored record. Returning null rejects the WHOLE
   * record and the tab opens unfiltered: a record written by a different build of this
   * page, or edited by hand, cannot be trusted field by field, and a half-applied
   * filter is worse than no filter.
   *
   * isDayKeyOrEmpty is the stricter guard the admin Classes list uses, not a bare
   * typeof check. A string that is not a real day key survives typeof but is not a
   * range: it would restore into date inputs that render blank for anything they cannot
   * parse, and into the lexical comparison below, which would then exclude every class
   * while the filter row showed nothing to clear.
   */
  function parseStoredClassesFilters(raw: unknown): ClassesStoredFilters | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>

    const from = record.from
    const to = record.to
    if (typeof from !== 'string' || typeof to !== 'string') return null
    if (!isDayKeyOrEmpty(from) || !isDayKeyOrEmpty(to)) return null

    let preset: DateRangePreset | null
    if (record.preset === null) preset = null
    else if (isDateRangePreset(record.preset)) preset = record.preset
    else return null

    return {
      preset,
      // Enforces the invariant on the way IN as well as on the way out: with a preset
      // active the stored dates are meaningless and the range comes from the clock.
      from: preset ? '' : from,
      to: preset ? '' : to,
    }
  }

  /**
   * Push a restored record into filter state. Runs once, from the hook's mount effect
   * - never during render, so the clock read below cannot desync server and client
   * markup.
   */
  function applyStoredClassesFilters(stored: ClassesStoredFilters) {
    if (stored.preset) {
      // Recomputed against NOW, which is the whole point of storing the id: a session
      // that spans midnight, or a tab returned to later in the day, gets the preset the
      // admin chose rather than the days it covered when they chose it.
      //
      // No timezone means no honest answer to "which day is today" - the same reason
      // DateRangeFilter disables the preset buttons on a null zone. The range restores
      // EMPTY rather than guessing UTC, and the hook then rewrites storage to match
      // what is actually on screen.
      const range = adminTzRaw ? getPresetRange(stored.preset, new Date(), adminTzRaw) : null
      setClassesFrom(range?.from ?? '')
      setClassesTo(range?.to ?? '')
    } else {
      setClassesFrom(stored.from)
      setClassesTo(stored.to)
    }
  }

  // `clear` is deliberately not taken off the return: the hook REMOVES the key by
  // itself the moment the record matches the default, which is the exact end state the
  // Clear button produces. skipRestore is false because no URL filter params reach this
  // tab - there is no deep link a restored range could quietly widen or narrow.
  useFilterPersistence<ClassesStoredFilters>({
    storageKey: CLASSES_FILTERS_STORAGE_KEY,
    value: persistedClassesFilters,
    defaultValue: DEFAULT_CLASSES_STORED_FILTERS,
    skipRestore: false,
    parse: parseStoredClassesFilters,
    apply: applyStoredClassesFilters,
  })

  // Derived per render, never held in state - stored, it would drift out of step the
  // moment either date input changed. Bucketed in adminTz (the DISPLAY zone), not
  // adminTzRaw: the Date & Time column below renders in adminTz, and the filter must
  // agree with what the admin can actually see. Both bounds are inclusive, and lexical
  // comparison is exact on fixed-width 'YYYY-MM-DD' keys.
  const filteredLessons = (classesFrom || classesTo)
    ? lessons.filter((l) => {
        const key = zonedDayKey(l.scheduled_at, adminTz)
        return (!classesFrom || key >= classesFrom) && (!classesTo || key <= classesTo)
      })
    : lessons

  // Create Training form state — only reachable when hasActiveTraining is false
  const [trainingPackage, setTrainingPackage] = useState('')
  const [trainingHours, setTrainingHours] = useState('')
  const [trainingEndDate, setTrainingEndDate] = useState('')
  const [trainingTeacherIds, setTrainingTeacherIds] = useState<string[]>([])
  const [trainingSaving, setTrainingSaving] = useState(false)
  const [trainingError, setTrainingError] = useState<string | null>(null)

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
  const [showPassword, setShowPassword] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  // Assignments state
  const [localAssignments, setLocalAssignments] = useState<Assignment[]>(initialAssignments)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [showAllAssignments, setShowAllAssignments] = useState(false)

  // Teaching-material homework state
  const [localMaterial, setLocalMaterial] = useState<MaterialHomework[]>(materialHomework)
  const [confirmMaterialRevokeId, setConfirmMaterialRevokeId] = useState<string | null>(null)
  const [revokingMaterialId, setRevokingMaterialId] = useState<string | null>(null)
  const [materialRevokeError, setMaterialRevokeError] = useState<string | null>(null)
  const [showAssignMaterial, setShowAssignMaterial] = useState(false)
  const [showRevokedMaterial, setShowRevokedMaterial] = useState(false)

  // Both mutations in this section (assign, revoke) re-run the server component
  // via router.refresh() rather than guessing the new row state locally. The
  // seeded copy above would otherwise keep showing the pre-refresh list, so it
  // follows the incoming prop.
  useEffect(() => {
    setLocalMaterial(materialHomework)
  }, [materialHomework])

  const id = student.id as string
  const fullName = (student.full_name as string | null) || (student.email as string | null) || 'this account'
  const photoUrl = student.photo_url as string | null
  const status = student.status as string | null

  const isFormer = status === 'former'
  // Fail-safe: an unproven eligibility check blocks the control. purgeBlockedBy
  // is empty both when nothing blocks AND when the pre-check query failed, so
  // it cannot carry that distinction on its own.
  const purgeReady = isFormer && purgeBlockedBy.length === 0 && !purgePreflightFailed

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
      setArchiving(false)
    }
  }

  async function handlePurge() {
    if (purgeConfirmName !== fullName) return
    setPurgeError(null)
    setPurging(true)
    try {
      const res = await fetch(`/api/admin/students/${id}`, { method: 'DELETE' })

      // The authoritative gate is purge_student_atomic behind this route, so the
      // structured 409/500 bodies below are the real reasons a purge failed --
      // surface them verbatim rather than a generic message. A non-JSON body
      // (proxy error page, empty response) must not throw past that handling.
      let data: {
        error?: string | null
        blockedBy?: unknown
        blocking?: unknown
        auth_user_id?: string | null
      }
      try {
        data = await res.json()
      } catch {
        data = { error: null }
      }

      if (res.ok) {
        setShowPurgeDialog(false)
        router.push('/admin/students')
        router.refresh()
        return
      }

      // 409 -- linked teachers are not archived. These names come from the RPC,
      // not from this page's advisory pre-check, so they are authoritative.
      if (Array.isArray(data.blockedBy) && data.blockedBy.length > 0) {
        setPurgeError(`${data.error || 'Purge blocked.'} Blocked by: ${data.blockedBy.join(', ')}`)
        return
      }

      // 409 -- the account also holds staff-side rows (dual identity).
      if (Array.isArray(data.blocking) && data.blocking.length > 0) {
        setPurgeError(
          `${data.error || 'Purge blocked.'} Blocking records: ` +
            data.blocking
              .map((b: { table: string; count: number }) => `${b.table} (${b.count})`)
              .join(', ')
        )
        return
      }

      // 500 -- the data purge SUCCEEDED but the auth user survived. The student
      // row is already gone, so navigating away or refreshing would strand the
      // admin on a 404 without the id they need. Keep the dialog open so the id
      // can be copied and the login removed by hand in Supabase Auth.
      if (data.auth_user_id) {
        setPurgeError(`${data.error} Auth user id: ${data.auth_user_id}`)
        return
      }

      // 400/404/500 with a plain body, or an unparseable one.
      setPurgeError(data.error || 'Failed to purge student.')
    } catch (err: unknown) {
      setPurgeError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPurging(false)
    }
  }

  function toggleTrainingTeacher(teacherId: string) {
    setTrainingTeacherIds((prev) =>
      prev.includes(teacherId)
        ? prev.filter((t) => t !== teacherId)
        : [...prev, teacherId]
    )
  }

  async function handleCreateTraining() {
    setTrainingError(null)
    if (!trainingPackage.trim()) {
      return setTrainingError('Package name is required.')
    }
    const hours = parseFloat(trainingHours)
    if (!trainingHours || isNaN(hours) || hours <= 0) {
      return setTrainingError('Enter a valid number of hours.')
    }
    setTrainingSaving(true)
    try {
      const res = await fetch(`/api/admin/students/${id}/trainings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_name: trainingPackage.trim(),
          total_hours: hours,
          end_date: trainingEndDate || null,
          teacher_ids: trainingTeacherIds,
        }),
      })

      // 409 (already has an active training), 404 and 422 all carry a message
      // written for this admin — surface it verbatim. A non-JSON body (proxy
      // error page, empty response) must not throw past that handling.
      let data: { error?: string | null }
      try {
        data = await res.json()
      } catch {
        data = { error: null }
      }

      if (!res.ok) throw new Error(data.error || 'Failed to create the training.')

      setTrainingPackage('')
      setTrainingHours('')
      setTrainingEndDate('')
      setTrainingTeacherIds([])
      // Success was previously silent: the card unmounts on refresh with nothing
      // confirming the write. The toast is portaled, so it survives that unmount.
      toast.success('Training created.')
      // Re-runs the server component: hasActiveTraining flips true, so the new
      // training renders in the Training card and this form disappears.
      router.refresh()
    } catch (err: unknown) {
      setTrainingError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setTrainingSaving(false)
    }
  }

  async function handleHoursSubmit() {
    setHoursError(null)
    // Both hour actions write to the ACTIVE training's balance. activeTrain is
    // NOT proof one exists — it falls back to the newest training of any status
    // — so without this guard a raw submit would either send a null training_id
    // (answered with a raw Zod message) or move hours on a finished package.
    if (!hasActiveTraining || !activeTrain) {
      return setHoursError(
        'This student has no active training. Create one on the Overview tab first.'
      )
    }
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

  async function handleRevoke(assignmentId: string) {
    setRevokingId(assignmentId)
    setRevokeError(null)
    try {
      const res = await fetch(`/api/admin/assignments/${assignmentId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to revoke assignment.')
      }
      setLocalAssignments(prev => prev.filter(a => a.id !== assignmentId))
      setConfirmRevokeId(null)
    } catch (err: unknown) {
      setRevokeError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setRevokingId(null)
    }
  }

  async function handleMaterialRevoke(assignmentId: string) {
    setRevokingMaterialId(assignmentId)
    setMaterialRevokeError(null)
    try {
      // The teacher revoke route is reused deliberately, and is not a teacher-only
      // endpoint: its gate is a USER-SCOPED select of the row, which the
      // "Admins read all material assignments" (is_admin()) SELECT policy passes.
      // The revoke write itself already runs on the service-role client behind
      // that gate, so an admin revoke needs no separate endpoint. It is a
      // SEMANTIC revoke — revoked_at is stamped and the row (with the student's
      // annotation layer) is kept.
      const res = await fetch(`/api/teacher/material-assignments/${assignmentId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to revoke this homework task.')
      }
      setConfirmMaterialRevokeId(null)
      // Re-read rather than stamping a revoked_at here: the row's real state
      // comes back from the database, never from a guess made in the browser.
      router.refresh()
    } catch (err: unknown) {
      setMaterialRevokeError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setRevokingMaterialId(null)
    }
  }

  // Collapsed to the 5 most recent by default — localAssignments already
  // arrives newest-first (assigned_at descending, from the fetch), so this is
  // a plain slice, not a re-sort — toggled on to show the rest.
  const visibleAssignments = showAllAssignments ? localAssignments : localAssignments.slice(0, 5)

  // Revoked rows stay in localMaterial (the audit trail), but are hidden from
  // the table by default — a pure client-side filter over the already-fetched
  // list, toggled on to show them back.
  const revokedMaterialCount = localMaterial.filter((hw) => hw.revoked_at !== null).length
  const visibleMaterial = showRevokedMaterial
    ? localMaterial
    : localMaterial.filter((hw) => hw.revoked_at === null)

  const allTabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'classes', label: 'Classes', count: lessons.length },
    { key: 'hours', label: 'Hours Log', count: hoursLog.length },
    { key: 'reports', label: 'Reports', count: reports.length },
    { key: 'assignments', label: 'Assignments', count: localAssignments.length },
    { key: 'messages', label: 'Messages', count: conversations.length },
    { key: 'reviews', label: 'Reviews', count: reviews.length },
  ]
  const tabs = isStaffView
    ? allTabs.filter(
        (t) =>
          t.key === 'overview' ||
          t.key === 'classes' ||
          t.key === 'reports' ||
          t.key === 'reviews'
      )
    : allTabs

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'

  return (
    <div className="p-6">
      {/* Back */}
      <button
        onClick={() => router.push('/admin/students')}
        className="text-sm text-gray-500 hover:text-gray-700 mb-4 block"
      >
        ← Students
      </button>

      {/* Top card */}
      <div className="card-elevated p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            {photoUrl ? (
              <img src={photoUrl} alt={fullName}
                className="w-[72px] h-[72px] rounded-full object-cover" />
            ) : (
              <div
                className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-white text-xl font-bold"
                style={{ backgroundColor: '#FF8303' }}
              >
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-bold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500 mb-2">{student.email as string}</p>
              {student.email_bounced_at ? (
                <EmailBounceNotice reason={student.email_bounce_reason as string | null} />
              ) : null}
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
                        ? { backgroundColor: '#FFEEE6', color: '#FD5602' }
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

          {/* Action buttons + purge block notice — mutation entry points, admin only */}
          {!isStaffView && (
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
                  title={
                    purgePreflightFailed
                      ? 'Purge unavailable: eligibility check failed - reload the page'
                      : !purgeReady
                      ? `Purge blocked: archive linked teachers first`
                      : undefined
                  }
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

            {/* Purge preflight failed notice - eligibility could not be proven */}
            {isFormer && purgePreflightFailed && (
              <div
                className="text-xs rounded-lg px-3 py-2 max-w-xs text-right"
                style={{ backgroundColor: '#fefce8', borderColor: '#fde68a', border: '1px solid #fde68a', color: '#92400e' }}
              >
                <p className="font-medium">Purge unavailable - the eligibility check could not run. Reload the page to retry.</p>
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 rounded-lg overflow-hidden w-fit flex-wrap"
        style={{ border: '1px solid #E0DFDC' }}>
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

      {/* ── Overview ── */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          {/* Personal info */}
          <div className="card-elevated p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Personal Information</h2>
            <InfoRow label="Full Name" value={fullName} />
            <InfoRow label="Email" value={student.email as string} />
            <InfoRow label="Phone" value={student.phone as string} />
            {!isStaffView && <InfoRow label="Date of Birth" value={student.date_of_birth as string} adminOnly />}
            <InfoRow label="Timezone" value={student.timezone as string} />
            <InfoRow label="Language Preference" value={student.language_preference as string} />
            {!isStaffView && <InfoRow label="Customer Number" value={student.customer_number as string} adminOnly />}
            {!isStaffView && <InfoRow label="Cancellation Policy" value={student.cancellation_policy as string} adminOnly />}
          </div>

          {/* Learning info */}
          <div className="card-elevated p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Learning Info</h2>
            <InfoRow label="Native Language" value={student.native_language as string} />
            <InfoRow label="Learning Language" value={student.learning_language as string} />
            <InfoRow label="Current Fluency Level" value={student.current_fluency_level as string} />
            <InfoRow label="Learning Goals" value={student.learning_goals as string} />
            <InfoRow label="Interests" value={student.interests as string} />
          </div>

          {/* Training info */}
          <div className="card-elevated p-5 space-y-4">
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
              <p className="text-sm text-gray-400">
                No active training.
                {!isStaffView && ' Use the Create Training card below to start one.'}
              </p>
            )}
          </div>

          {/* Assigned teachers */}
          <div className="card-elevated p-5 space-y-4">
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

          {/* Create Training — rendered ONLY when the student has no training
              with status === 'active' (hasActiveTraining, strict). A second
              active training is refused by create_training_atomic and by the
              one_active_training_per_student partial unique index, so the form
              must never sit next to a live one. Admin only: staff get no
              mutation entry points on this page. */}
          {!isStaffView && !hasActiveTraining && (
          <div className="col-span-2 card-elevated p-5 space-y-4">
            <div>
              <h2 className="font-semibold text-gray-800">Create Training</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                A training holds the package, the hours balance and the assigned teachers.
                Hours can only be added once one exists.
              </p>
            </div>

            {teacherOptionsLoadFailed && (
              <div
                className="text-xs rounded-lg px-3 py-2"
                style={{ backgroundColor: '#fefce8', borderColor: '#fde68a', border: '1px solid #fde68a', color: '#92400e' }}
              >
                <p className="font-medium">
                  The teacher list could not be loaded, so it may be incomplete. Reload the page before assigning teachers.
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Package Name
                <span className="ml-1 font-normal" style={{ color: '#FD5602' }}>(required)</span>
              </label>
              <input
                className={inputClass}
                value={trainingPackage}
                onChange={(e) => setTrainingPackage(e.target.value)}
                placeholder="e.g. Standard 20hrs, Intensive B2"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Total Hours
                  <span className="ml-1 font-normal" style={{ color: '#FD5602' }}>(required)</span>
                </label>
                <input
                  type="number" min="0.5" step="0.5"
                  className={inputClass}
                  value={trainingHours}
                  onChange={(e) => setTrainingHours(e.target.value)}
                  placeholder="e.g. 20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  End Date
                  <span className="ml-1 text-gray-400 font-normal">(optional)</span>
                </label>
                <DatePartInput
                  value={trainingEndDate}
                  onChange={(v) => setTrainingEndDate(v)}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Assigned Teacher(s)
              </label>
              <div className="flex flex-wrap gap-2 mt-1">
                {teacherOptions.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTrainingTeacher(t.id)}
                    className="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors"
                    style={
                      trainingTeacherIds.includes(t.id)
                        ? { backgroundColor: '#FFF0E0', color: '#FF8303', borderColor: '#FF8303' }
                        : { backgroundColor: 'white', color: '#4b5563', borderColor: '#E0DFDC' }
                    }
                  >
                    {t.full_name}
                  </button>
                ))}
              </div>
              {teacherOptions.length === 0 && !teacherOptionsLoadFailed && (
                <p className="text-xs text-gray-400 mt-1">No active teachers found.</p>
              )}
              {/* Zero teachers is a legal selection — the training is created
                  either way — but it is never what the admin meant to leave
                  behind, so say what it costs the student. */}
              {trainingTeacherIds.length === 0 && (
                <p className="text-xs mt-2" style={{ color: '#B45309' }}>
                  No teachers assigned — the student will not be able to book classes.
                  Teachers can be added later from the Edit page.
                </p>
              )}
            </div>

            {trainingError && (
              <div className="px-4 py-3 rounded-lg text-sm"
                style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
                {trainingError}
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleCreateTraining}
                disabled={trainingSaving}
                className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#FF8303' }}
              >
                {trainingSaving ? 'Creating...' : 'Create Training'}
              </button>
            </div>
          </div>
          )}

          {/* Teacher notes */}
          <div className="card-elevated p-5 space-y-2">
            <h2 className="font-semibold text-gray-800">Teacher Notes</h2>
            <p className="text-sm text-gray-600">
              {(student.teacher_notes as string) || 'No teacher notes.'}
            </p>
            <p className="text-xs text-gray-400">Visible to assigned teachers. Not visible to student.</p>
          </div>

          {/* Admin notes */}
          {!isStaffView && (
          <div className="rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
            <h2 className="font-semibold" style={{ color: '#92400e' }}>
              🔒 Admin Notes — Not visible to teacher or student
            </h2>
            <p className="text-sm" style={{ color: '#78350f' }}>
              {(student.admin_notes as string) || 'No admin notes.'}
            </p>
          </div>
          )}

          {/* Password override — admin only, full width */}
          {!isStaffView && (
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
          )}

          {/* Open tasks linked to this student. TasksMini renders its own header, so this
              wrapper supplies only the card — card-elevated p-5 is this file's neutral
              overview-card class, with col-span-2 (not the teacher page's col-span-3)
              because this overview grid is grid-cols-2. linkedId is students.id, which is
              what admin_tasks.linked_entity_id holds for linked_entity_type 'student': the
              TaskForm student dropdown is fed by /api/admin/students?minimal=true, i.e.
              students rows, and the tasks route resolves those ids back against `students`.
              Admin-gated like the two panels above it — /api/admin/tasks is requireAdmin(),
              which requireStaff() explicitly excludes tasks from, so for a staff viewer this
              panel could only render a permission error and an Add Task button they cannot use. */}
          {!isStaffView && (
          <div className="col-span-2 card-elevated p-5">
            <TasksMini
              linkedType="student"
              linkedId={id}
              linkedName={fullName}
              adminTz={adminTz}
            />
          </div>
          )}
        </div>
      )}

      {/* ── Classes ── */}
      {activeTab === 'classes' && (
        <div className="space-y-2">
          {lessonsCapped && (
            <p className="text-sm text-gray-400">Showing the most recent 1000 classes.</p>
          )}
          {/* Date range filter over the list below. Purely client-side: this
              student's classes already arrived in the page props, so this narrows what
              is on screen without a refetch. The range survives navigation for the rest
              of the session (sessionStorage), because the month-end workflow is one
              range applied across many students. */}
          <div className="card-elevated p-4">
            <div className="flex flex-wrap items-end gap-3">
              <DateRangeFilter
                from={classesFrom}
                to={classesTo}
                onChange={(f, t) => { setClassesFrom(f); setClassesTo(t) }}
                tz={adminTzRaw}
              />
              {(classesFrom || classesTo) && (
                <button
                  type="button"
                  onClick={() => { setClassesFrom(''); setClassesTo('') }}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Clear
                </button>
              )}
            </div>
            {(classesFrom || classesTo) && (
              <p className="text-xs text-gray-500 mt-2">
                Showing {filteredLessons.length} of {lessons.length} classes
              </p>
            )}
          </div>

          <div className="card-elevated overflow-hidden">
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
                {/* Two distinct empty states. Collapsing them into one would tell an
                    admin who has filtered to an empty month that this student has never
                    had a class, when their classes are simply outside the range they
                    chose. */}
                {lessons.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-10 text-gray-400">No classes yet.</td>
                  </tr>
                ) : filteredLessons.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-10 text-gray-400">
                      No classes in the selected date range.
                    </td>
                  </tr>
                ) : (
                  filteredLessons.map((lesson) => (
                    <tr key={lesson.id} className="border-b border-gray-50">
                      <td className="px-4 py-3 text-gray-800">{lesson.teacher_name}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {new Date(lesson.scheduled_at).toLocaleString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                          timeZone: adminTz,
                        })}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {lesson.duration_minutes} min
                        <DurationMarker
                          status={lesson.status}
                          durationMinutes={lesson.duration_minutes}
                          allowed={student.allowed_durations}
                        />
                      </td>
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

      {/* ── Hours Log ── */}
      {activeTab === 'hours' && (
        <div className="space-y-4">
          {/* Add / Remove buttons. Both post a training_id to the hours route,
              which requires a uuid — with no active training the click could
              only ever end in a raw Zod message, so the controls are disabled
              and point at Create Training instead. Gated on hasActiveTraining,
              not on activeTrain: that falls back to the newest training of any
              status, so a finished package would leave both buttons live. */}
          <div className="flex gap-3 items-center flex-wrap">
            <button
              onClick={() => setHoursAction(hoursAction === 'add' ? null : 'add')}
              disabled={!hasActiveTraining}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#16a34a' }}
              title={!hasActiveTraining ? 'This student has no active training — create one on the Overview tab first' : undefined}
            >
              + Add Hours
            </button>
            <button
              onClick={() => setHoursAction(hoursAction === 'remove' ? null : 'remove')}
              disabled={!hasActiveTraining}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title={!hasActiveTraining ? 'This student has no active training — create one on the Overview tab first' : undefined}
            >
              − Remove Hours
            </button>
            {!hasActiveTraining && (
              <span className="text-xs" style={{ color: '#B45309' }}>
                No active training — create one on the Overview tab before adding or removing hours.
              </span>
            )}
          </div>

          {/* Inline add/remove form */}
          {hoursAction && (
            <div className="card-elevated p-5 space-y-4">
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

          {/* Date range filter over the log below. Purely client-side: the whole log
              for this student already arrived in the page props, so this narrows what
              is on screen without a refetch. The range survives navigation for the rest
              of the session (sessionStorage), because the month-end workflow is one
              range applied across many students. */}
          <div className="card-elevated p-4">
            <div className="flex flex-wrap items-end gap-3">
              <DateRangeFilter
                from={hoursFrom}
                to={hoursTo}
                onChange={(f, t) => { setHoursFrom(f); setHoursTo(t) }}
                tz={adminTzRaw}
              />
              {(hoursFrom || hoursTo) && (
                <button
                  type="button"
                  onClick={() => { setHoursFrom(''); setHoursTo('') }}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Clear
                </button>
              )}
            </div>
            {(hoursFrom || hoursTo) && (
              <p className="text-xs text-gray-500 mt-2">
                Showing {filteredHoursLog.length} of {hoursLog.length} transactions
              </p>
            )}
          </div>

          {/* Hours log table */}
          <div className="card-elevated overflow-hidden">
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
                {/* Two distinct empty states. Collapsing them into one would tell an
                    admin who has filtered to an empty month that this student has no
                    hours history at all, when the history is simply outside the range
                    they chose. */}
                {hoursLog.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-gray-400">
                      No hours transactions yet.
                    </td>
                  </tr>
                ) : filteredHoursLog.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-gray-400">
                      No transactions in the selected date range.
                    </td>
                  </tr>
                ) : (
                  filteredHoursLog.map((entry) => (
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
                          timeZone: adminTz,
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
        <div className="space-y-2">
          {reportsCapped && (
            <p className="text-sm text-gray-400">Showing the most recent 1000 reports.</p>
          )}
          <div className="card-elevated overflow-hidden">
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
                              timeZone: adminTz,
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{report.teacher_name || '—'}</td>
                      <td className="px-4 py-3">
                        {/* Three states, not two: happened stays null until the
                            report is filed. Falling through to the red 'No' read
                            as "the class did not take place" when it only meant
                            nothing had been reported yet — hence the explicit
                            === true / === false comparisons. */}
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-medium"
                          style={
                            report.happened === true
                              ? { backgroundColor: '#DCFCE7', color: '#15803D' }
                              : report.happened === false
                              ? { backgroundColor: '#FFEEE6', color: '#FD5602' }
                              : { backgroundColor: '#E0DFDC', color: '#000000' }
                          }
                        >
                          {report.happened === true
                            ? 'Yes'
                            : report.happened === false
                            ? 'No'
                            : report.status === 'flagged'
                            ? 'Missed'
                            : 'Awaiting report'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                        {report.feedback || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {new Date(report.created_at).toLocaleDateString('en-GB', {
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
        </div>
      )}

      {/* ── Assignments ── */}
      {activeTab === 'assignments' && (
        <div className="space-y-3">
          {revokeError && (
            <div className="px-4 py-3 rounded-lg text-sm"
              style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
              {revokeError}
            </div>
          )}
          <div className="card-elevated overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Sheet</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Level</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Source</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date Assigned</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {visibleAssignments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-gray-400">
                      No study sheets assigned yet.
                    </td>
                  </tr>
                ) : (
                  visibleAssignments.map((assignment) => {
                    const isConfirming = confirmRevokeId === assignment.id
                    const isRevoking = revokingId === assignment.id
                    return (
                      <tr key={assignment.id} className="border-b border-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {assignment.study_sheet.title}
                        </td>
                        <td className="px-4 py-3">
                          <CategoryBadge category={assignment.study_sheet.category} />
                        </td>
                        <td className="px-4 py-3">
                          {assignment.study_sheet.level && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                              style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
                            >
                              {assignment.study_sheet.level}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={
                              assignment.lesson_id
                                ? { backgroundColor: '#FFF8E8', color: '#B45309' }
                                : { backgroundColor: '#f3f4f6', color: '#6b7280' }
                            }
                          >
                            {assignment.lesson_id ? 'From Class' : 'Direct'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {new Date(assignment.assigned_at).toLocaleDateString('en-GB', {
                            day: '2-digit', month: 'short', year: 'numeric',
                            timeZone: adminTz,
                          })}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isConfirming ? (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => setConfirmRevokeId(null)}
                                disabled={isRevoking}
                                className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => handleRevoke(assignment.id)}
                                disabled={isRevoking}
                                className="text-xs px-3 py-1 rounded text-white disabled:opacity-50"
                                style={{ backgroundColor: '#dc2626' }}
                              >
                                {isRevoking ? 'Revoking…' : 'Confirm Revoke'}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setRevokeError(null); setConfirmRevokeId(assignment.id) }}
                              className="text-xs underline text-red-400 hover:text-red-600"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {localAssignments.length > 5 && (
            <button
              onClick={() => setShowAllAssignments((v) => !v)}
              className="text-xs font-medium underline"
              style={{ color: '#6b7280' }}
            >
              {showAllAssignments
                ? 'Show fewer'
                : `Show all (${localAssignments.length})`}
            </button>
          )}

          {/* ── Homework (Teaching Material) ── */}
          <div className="flex items-center justify-between pt-4">
            <h3 className="text-sm font-semibold text-gray-800">Homework (Teaching Material)</h3>
            <button
              onClick={() => { setMaterialRevokeError(null); setShowAssignMaterial(true) }}
              disabled={materialSheets.length === 0}
              title={
                materialSheets.length > 0
                  ? undefined
                  : materialSheetsLoadFailed
                    ? 'The teaching-material list could not be loaded, so nothing can be assigned right now.'
                    : 'There is no active teaching material to assign.'
              }
              className="btn-primary-hover px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#FF8303' }}
            >
              Assign teaching material
            </button>
          </div>

          {materialSheetsLoadFailed && (
            <div className="px-4 py-3 rounded-lg text-sm"
              style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
              The teaching-material list could not be loaded, so nothing can be assigned right now.
              This does not mean there is none — refresh the page to try again.
            </div>
          )}

          {materialRevokeError && (
            <div className="px-4 py-3 rounded-lg text-sm"
              style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
              {materialRevokeError}
            </div>
          )}

          {materialHomeworkLoadFailed ? (
            <div className="card-elevated px-4 py-8 text-center text-sm"
              style={{ color: '#dc2626' }}>
              The homework list could not be loaded. This is not an empty list — the grants are
              still there. Refresh the page to try again.
            </div>
          ) : (
            <div className="card-elevated overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Material</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Pages</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Date Assigned</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {visibleMaterial.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center py-10 text-gray-400">
                        {localMaterial.length === 0
                          ? 'No teaching material assigned yet.'
                          : 'No live teaching material — all assignments are revoked.'}
                      </td>
                    </tr>
                  ) : (
                    visibleMaterial.map((hw) => {
                      const isConfirming = confirmMaterialRevokeId === hw.id
                      const isRevoking = revokingMaterialId === hw.id
                      const isLive = hw.revoked_at === null
                      return (
                        <tr key={hw.id} className="border-b border-gray-50">
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900">
                              {hw.sheet_title ?? hw.attachment_name}
                            </p>
                            {hw.sheet_title && (
                              <p className="text-xs text-gray-400 mt-0.5">{hw.attachment_name}</p>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className="px-2 py-0.5 rounded-full text-xs font-medium"
                              style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                            >
                              {hw.page_start === null || hw.page_end === null
                                ? 'Whole document'
                                : `Pages ${hw.page_start}-${hw.page_end}`}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500">
                            {new Date(hw.assigned_at).toLocaleDateString('en-GB', {
                              day: '2-digit', month: 'short', year: 'numeric',
                              timeZone: adminTz,
                            })}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className="px-2 py-0.5 rounded-full text-xs font-medium"
                              style={
                                isLive
                                  ? { backgroundColor: '#DCFCE7', color: '#15803D' }
                                  : { backgroundColor: '#f3f4f6', color: '#6b7280' }
                              }
                            >
                              {isLive ? 'Live' : 'Revoked'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {!isLive ? null : isConfirming ? (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => setConfirmMaterialRevokeId(null)}
                                  disabled={isRevoking}
                                  className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleMaterialRevoke(hw.id)}
                                  disabled={isRevoking}
                                  className="text-xs px-3 py-1 rounded text-white disabled:opacity-50"
                                  style={{ backgroundColor: '#dc2626' }}
                                >
                                  {isRevoking ? 'Revoking…' : 'Confirm Revoke'}
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setMaterialRevokeError(null); setConfirmMaterialRevokeId(hw.id) }}
                                className="text-xs underline text-red-400 hover:text-red-600"
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {!materialHomeworkLoadFailed && revokedMaterialCount > 0 && (
            <button
              onClick={() => setShowRevokedMaterial((v) => !v)}
              className="text-xs font-medium underline"
              style={{ color: '#6b7280' }}
            >
              {showRevokedMaterial
                ? 'Hide revoked'
                : `Show revoked (${revokedMaterialCount})`}
            </button>
          )}
        </div>
      )}

      {/* ── Messages ── */}
      {activeTab === 'messages' && (
        conversations.length === 0 ? (
          <div className="card-elevated p-8 text-center">
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
                  studentId={id}
                  timezone={adminTz}
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
            <div className="card-elevated p-8 text-center">
              <p className="text-gray-400 text-sm">No reviews submitted yet.</p>
            </div>
          ) : (
            reviews.map((review) => (
              <div key={review.id} className="card-elevated p-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{review.teacher_name}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(review.submitted_at).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        timeZone: adminTz,
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

      {/* ─── Assign teaching material ─────────────────────────────────────────── */}
      {/* Mounted only while open, so nothing about it runs on a normal page load. */}
      {showAssignMaterial && (
        <AssignMaterialHomeworkModal
          studentId={id}
          studentName={fullName}
          sheets={materialSheets}
          onClose={() => setShowAssignMaterial(false)}
          onAssigned={() => router.refresh()}
        />
      )}
    </div>
  )
}
