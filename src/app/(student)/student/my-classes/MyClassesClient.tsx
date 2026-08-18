'use client'

import { useState, useEffect, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  User,
  Plus,
  CalendarDays,
  GraduationCap,
  Clock,
  Flame,
  Loader2,
} from 'lucide-react'
import { cancelLessonAction } from './actions'
import { describeLessonCountdown } from '@/lib/lessons/countdown'
import { formatDayDivider, formatMonth, endOfWeekKey, endOfMonthKey } from '@/lib/lessons/agendaDates'
import { getLocalDateKey as getTzDateKey, addDaysToDateKey, wallTimeToUtcMs } from '@/lib/utils/timezone'
import { isCancelledStatus } from '@/lib/billing/billability'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { Button } from '@/components/ui/button'
import { EmptyStateCalendar } from '@/components/EmptyStateCalendar'
import CalendarSubscriptionCard from '@/components/shared/CalendarSubscriptionCard'

interface Teacher {
  id: string
  full_name: string
  photo_url: string | null
}

interface Lesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teams_join_url: string | null
  status: string
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  teacher_id: string
  training_id: string
  teacher: Teacher | null
}

interface MyClassesClientProps {
  lessons: Lesson[]
  lastFeedback: string | null
  studentTimezone: string
  profileCompleted: boolean
  bannerDismissed: boolean
  hoursRemaining: number | null // null = no active training record (NOT the same as 0)
  trainingEndDate: string | null
  completedCount: number
  hoursCompleted: number
  streakWeeks: number
  notice: 'reschedule_unavailable' | null
}

// Format a date for display — uses Intl with explicit timezone, safe on client
function formatDate(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(isoString))
}

function formatTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    hour12: false,
  }).format(new Date(isoString))
}

function formatTimeRange(isoString: string, timezone: string, durationMinutes: number): string {
  const start = new Date(isoString)
  const end = new Date(start.getTime() + durationMinutes * 60000)
  return `${formatTime(isoString, timezone)} - ${formatTime(end.toISOString(), timezone)}`
}

// Returns YYYY-MM-DD in the student's local timezone — used to group lessons by day
function getLocalDateKey(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(isoString)) // en-CA gives YYYY-MM-DD format
}

// Hours + end-date formatting for the empty-state meta line. Replicated from
// src/components/student/layout/StudentRightPanel.tsx (not exported there) — keep the
// two in sync so the empty state always reads the same as the right panel.
function formatHours(hours: number): string {
  if (hours === 0) return '0 hours' // bold "0h" reads as the word "oh"
  const sign = hours < 0 ? '-' : ''
  const abs = Math.abs(hours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  if (m === 0) return `${sign}${h}h`
  return `${sign}${h}h ${m}min`
}

// trainings.end_date is a DATE column, not an instant.
function formatEndDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

function getSecondsUntil(isoString: string, now: number): number {
  return Math.max(0, Math.floor((new Date(isoString).getTime() - now) / 1000))
}

function isWithin24Hours(isoString: string, now: number): boolean {
  return getSecondsUntil(isoString, now) < 86400
}

// ── Stat card — copied from the teacher StudySheetsClient design system ──
function StatCard({
  icon: Icon,
  label,
  value,
  caption,
  valueColor = '#111827',
}: {
  icon: typeof CalendarDays
  label: string
  value: string | number
  caption: string
  valueColor?: string
}) {
  return (
    <div className="flex-1 min-w-[200px] rounded-xl p-5 shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6' }}>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: '32px', height: '32px', backgroundColor: '#FFF3E0' }}
        >
          <Icon className="w-4 h-4" style={{ color: '#FF8303' }} />
        </span>
        <span className="text-sm font-medium" style={{ color: '#4b5563' }}>{label}</span>
      </div>
      <p className="text-3xl font-semibold" style={{ color: valueColor }}>{value}</p>
      <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{caption}</p>
    </div>
  )
}

// ── Shared 24-hour cancel warning (house red palette) ──
function CancelWarning({ onConfirm, onDismiss }: { onConfirm: () => void; onDismiss: () => void }) {
  return (
    <div style={{
      marginTop: '10px',
      padding: '10px 14px',
      backgroundColor: '#FFF3EE',
      border: '1px solid #FFD9C7',
      borderRadius: '6px',
    }}>
      <p style={{ fontSize: '13px', color: '#FD5602', marginBottom: '8px' }}>
        This class starts in less than 24 hours. If you cancel now, you will lose your class credit. Continue?
      </p>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={onConfirm}
          style={{
            padding: '5px 12px',
            backgroundColor: '#FD5602',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '500',
            cursor: 'pointer',
          }}
        >
          Yes, cancel
        </button>
        <button
          onClick={onDismiss}
          style={{
            padding: '5px 12px',
            backgroundColor: 'transparent',
            border: '1px solid #E0DFDC',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '500',
            color: '#4b5563',
            cursor: 'pointer',
          }}
        >
          Go back
        </button>
      </div>
    </div>
  )
}

// ── Shared outline secondary button — hover feedback like Book a Class ──
function SecondaryButton({
  onClick,
  disabled,
  title,
  children,
  padding,
  fontSize,
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
  children: ReactNode
  padding: string
  fontSize: string
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding,
        backgroundColor: disabled ? 'transparent' : hovered ? '#f3f4f6' : 'transparent',
        border: disabled ? '1px solid #E5E7EB' : '1px solid #E0DFDC',
        borderRadius: '6px',
        fontSize,
        fontWeight: '500',
        color: disabled ? '#9CA3AF' : hovered ? '#111827' : '#4b5563',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background-color 0.18s ease, color 0.18s ease',
      }}
    >
      {children}
    </button>
  )
}

// ── Shared lesson row — used by the upcoming day groups ──
function LessonRow({
  lesson,
  studentTimezone,
  mounted,
  now,
  isFirst,
  isNext,
  lastFeedback,
  showDate,
  cancellingId,
  showCancelWarning,
  onReschedule,
  onCancel,
  onDismissWarning,
}: {
  lesson: Lesson
  studentTimezone: string
  mounted: boolean
  now: number
  isFirst: boolean
  isNext: boolean
  lastFeedback: string | null
  showDate: boolean
  cancellingId: string | null
  showCancelWarning: string | null
  onReschedule: (id: string) => void
  onCancel: (id: string, within24: boolean) => void
  onDismissWarning: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [joinHovered, setJoinHovered] = useState(false)
  const isCancelled = isCancelledStatus(lesson.status)
  const cancelLabel = getCancellationLabel(lesson, 'student')
  const within24 = mounted && !isCancelled && isWithin24Hours(lesson.scheduled_at, now)
  // A class stays in this list until it ENDS, so a live class is an ordinary row here and
  // the shared helper keeps it reading "47:37" instead of "Starting now". The same result
  // drives the IN CLASS pill below, so pill and timer can never disagree.
  // Pure epoch ms - scheduled_at is an instant and duration_minutes is a plain offset.
  const startMs = new Date(lesson.scheduled_at).getTime()
  const countdown = mounted
    ? describeLessonCountdown(startMs, startMs + lesson.duration_minutes * 60000, now)
    : null
  const isCancelling = cancellingId === lesson.id
  // The next class is marked where it sits rather than lifted into a hero above the list.
  // ANDed with mounted before it can affect anything rendered, so the server emits no
  // rail, no pill and no Join button, and the first client pass agrees with it.
  const isNextRow = mounted && isNext
  // Join replaces the countdown inside the 10-minute window, on the next row only - the
  // same four arguments the deleted hero passed, ticked by the same `now`, so the button
  // appears and disappears on its own with no reload. A null teams_join_url falls back to
  // the countdown rather than rendering a button that cannot work.
  const canJoin =
    isNextRow &&
    !!lesson.teams_join_url &&
    isLessonJoinable(lesson.scheduled_at, lesson.duration_minutes, lesson.status, now)

  const timeText = showDate
    ? `${formatDate(lesson.scheduled_at, studentTimezone)} · ${formatTimeRange(lesson.scheduled_at, studentTimezone, lesson.duration_minutes)}`
    : formatTimeRange(lesson.scheduled_at, studentTimezone, lesson.duration_minutes)

  return (
    <div>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          backgroundColor: hovered ? '#f9fafb' : '#ffffff',
          borderTop: isFirst ? 'none' : '1px solid #F3F4F6',
          // The left rail marks the next class in place. isNextRow already carries the
          // mounted gate the pill uses, so the server renders no rail and the first
          // client pass agrees with it.
          borderLeft: isNextRow ? '3px solid #FF8303' : undefined,
          padding: '14px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

          {/* Teacher photo */}
          <div style={{ flexShrink: 0, width: '36px', height: '36px', borderRadius: '50%', overflow: 'hidden', border: '1px solid #E0DFDC' }}>
            {lesson.teacher?.photo_url ? (
              <Image
                src={lesson.teacher.photo_url}
                alt={lesson.teacher.full_name}
                width={36}
                height={36}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: '#f3f4f6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <User size={16} color="#9ca3af" />
              </div>
            )}
          </div>

          {/* Teacher name and time */}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
              <span style={{
                fontSize: '14px',
                fontWeight: '600',
                color: isCancelled ? '#9ca3af' : '#111827',
              }}>
                {lesson.teacher?.full_name ?? 'Teacher'}
              </span>
              {isCancelled && (
                <span style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  padding: '2px 8px',
                  backgroundColor: '#FFF3EE',
                  color: '#FD5602',
                  borderRadius: '4px',
                }}>
                  Cancelled
                </span>
              )}
              {isNextRow && (
                <span style={{
                  fontSize: '10px',
                  fontWeight: '700',
                  letterSpacing: '0.06em',
                  padding: '2px 8px',
                  backgroundColor: '#FF8303',
                  color: '#ffffff',
                  borderRadius: '4px',
                }}>
                  {countdown?.live ? 'IN CLASS' : 'NEXT'}
                </span>
              )}
            </div>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>
              {mounted ? timeText : ''} · {lesson.duration_minutes} min
            </span>
          </div>

          {/* Join Class inside the 10-minute window, otherwise the countdown - never both,
              and never a permanently disabled button. Join-click logging stays with the
              right panel: a second caller here would double-count it. */}
          {!isCancelled && mounted && (
            canJoin ? (
              <a
                href={lesson.teams_join_url!}
                target="_blank"
                rel="noopener noreferrer"
                onMouseEnter={() => setJoinHovered(true)}
                onMouseLeave={() => setJoinHovered(false)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  padding: '6px 14px',
                  backgroundColor: joinHovered ? '#e67300' : '#FF8303',
                  color: '#ffffff',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '600',
                  textDecoration: 'none',
                  transition: 'background-color 0.18s ease',
                }}
              >
                Join Class
              </a>
            ) : (
              <span className="font-mono text-sm" style={{ color: '#FF8303', flexShrink: 0 }}>
                {countdown?.value ?? ''}
              </span>
            )
          )}

          {/* Reschedule / Cancel buttons */}
          {!isCancelled && (
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              <SecondaryButton
                onClick={() => onReschedule(lesson.id)}
                disabled={!!within24}
                title={within24 ? 'Reschedule not available within 24 hours of class' : ''}
                padding="5px 10px"
                fontSize="12px"
              >
                Reschedule
              </SecondaryButton>
              <SecondaryButton
                onClick={() => onCancel(lesson.id, !!within24)}
                disabled={isCancelling}
                padding="5px 10px"
                fontSize="12px"
              >
                {isCancelling ? 'Cancelling...' : 'Cancel'}
              </SecondaryButton>
            </div>
          )}
        </div>

        {/* About This Class - the most recent report feedback, carried down from the
            deleted hero card. Only the next class row is passed it; every other row
            receives null and renders nothing here. */}
        {lastFeedback && (
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f3f4f6' }}>
            <p style={{
              fontSize: '11px',
              fontWeight: '600',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#9ca3af',
              marginBottom: '6px',
            }}>
              About This Class
            </p>
            <p style={{
              fontSize: '13px',
              color: '#6b7280',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {lastFeedback}
            </p>
          </div>
        )}

        {/* 24-hour cancel warning — inline in list */}
        {showCancelWarning === lesson.id && (
          <CancelWarning
            onConfirm={() => onCancel(lesson.id, true)}
            onDismiss={onDismissWarning}
          />
        )}

        {(lesson.cancelled_by || lesson.rescheduled_by) && cancelLabel && (
          <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
            {cancelLabel}
          </p>
        )}
      </div>
    </div>
  )
}

export default function MyClassesClient({
  lessons,
  lastFeedback,
  studentTimezone,
  profileCompleted,
  bannerDismissed,
  hoursRemaining,
  trainingEndDate,
  completedCount,
  hoursCompleted,
  streakWeeks,
  notice,
}: MyClassesClientProps) {
  const router = useRouter()

  const [showProfileBanner, setShowProfileBanner] = useState<boolean>(!profileCompleted && !bannerDismissed)
  const [isDismissingBanner, setIsDismissingBanner] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [now, setNow] = useState(0) // 0 until mounted — avoids hydration mismatch
  const [mounted, setMounted] = useState(false)
  // Today's date key in the STUDENT's timezone. Set in the effect below, never during
  // render: a clock read in a render body would make the SSR pass disagree with hydration.
  // Null until mounted, which formatDayDivider treats as "no relative label", falling back
  // to the absolute date.
  const [todayKey, setTodayKey] = useState<string | null>(null)
  const [rangeFilter, setRangeFilter] = useState<'week' | 'month' | 'all'>('month')
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [showCancelWarning, setShowCancelWarning] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [bookHovered, setBookHovered] = useState(false)

  useEffect(() => {
    const currentNow = Date.now()
    setNow(currentNow)
    setMounted(true)

    // Tick every second for countdowns
    const interval = setInterval(() => setNow(Date.now()), 1000)
    // Catch external changes (e.g. teacher or admin cancellations)
    const pollInterval = setInterval(() => router.refresh(), 30_000)
    return () => {
      clearInterval(interval)
      clearInterval(pollInterval)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // todayKey is refreshed at each local midnight by this self-rescheduling timer, so a tab
  // left open across the boundary does not keep labelling yesterday's group "Today". Kept
  // separate from the tick effect above on purpose: that one is pinned to an empty dep
  // array, this one must re-run when the student's timezone changes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    // Reads the key from the clock on every hop rather than incrementing the previous key.
    // That is what makes an imprecise fire harmless: early (clock skew) leaves the old key
    // and reschedules a second later; late (throttled background tab, or a zone whose DST
    // transition lands ON midnight so 00:00 does not exist that day and wallTimeToUtcMs
    // resolves past the gap) still reads the correct current day.
    function schedule() {
      const key = getTzDateKey(new Date(), studentTimezone)
      setTodayKey(key)

      const [y, m, d] = addDaysToDateKey(key, 1).split('-').map(Number)
      const nextMidnightMs = wallTimeToUtcMs(y, m, d, 0, 0, studentTimezone)
      // Floor the delay: an early fire must never schedule a zero-delay loop. One extra
      // hop a second later lands past the boundary and settles.
      const delay = Math.max(nextMidnightMs - Date.now(), 1000)
      timer = setTimeout(schedule, delay)
    }

    schedule()

    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [studentTimezone])

  // Every scheduled lesson is a row in the flat agenda below - nothing is lifted out of
  // the list any more, so the next class is simply the first row of its own day group.
  const scheduledLessons = lessons.filter((l) => l.status === 'scheduled')

  // The row that carries the left rail, the NEXT / IN CLASS pill, the Join button and the
  // recap. lessons arrives ordered by scheduled_at ascending, so the first scheduled row
  // is the next class.
  // Deliberately read off the UNFILTERED list: the earliest class's date key is always
  // <= the bound of any window that shows anything at all, so the rail, the pill, the Join
  // button and the recap can never be filtered out from under themselves.
  const nextId = scheduledLessons[0]?.id ?? null

  // Calendar window from today, in the student's own timezone, so both labels are
  // literally true: "This Week" ends on the coming Sunday and "This Month" on the last day
  // of today's own month. The bound is derived once per render here, not rebuilt for every
  // lesson in the callback.
  //
  // While todayKey is null (pre-mount), no filter is applied - the list must match the
  // server-rendered HTML exactly on the first client pass, narrowing only after hydration
  // supplies today's key, the same pattern the Today/Tomorrow divider labels follow.
  const rangeMaxKey =
    todayKey === null || rangeFilter === 'all'
      ? null
      : rangeFilter === 'week'
        ? endOfWeekKey(todayKey)
        : endOfMonthKey(todayKey)

  const visibleLessons = rangeMaxKey === null
    ? scheduledLessons
    : scheduledLessons.filter((l) => getLocalDateKey(l.scheduled_at, studentTimezone) <= rangeMaxKey)

  // Group the visible lessons by their date in the student's own timezone
  const groupedByDate: Record<string, Lesson[]> = {}
  visibleLessons.forEach((lesson) => {
    const key = getLocalDateKey(lesson.scheduled_at, studentTimezone)
    if (!groupedByDate[key]) groupedByDate[key] = []
    groupedByDate[key].push(lesson)
  })
  const sortedDays = Object.keys(groupedByDate).sort()

  async function handleCancel(lessonId: string, within24: boolean) {
    // Show warning first if within 24 hours — user must confirm
    if (within24 && showCancelWarning !== lessonId) {
      setShowCancelWarning(lessonId)
      setCancelError(null)
      return
    }
    setCancellingId(lessonId)
    setCancelError(null)

    // Server action handles cancellation + hours refund logic atomically.
    // If >24hrs before class: hours_consumed is decremented (refund).
    // If <24hrs before class: hours_consumed is unchanged (no refund).
    // cancelLessonAction returns its errors rather than throwing, but the call can
    // still reject: createClient() runs above every guarded branch in it, and a
    // network fault or a stale deployment id fails the action request outright.
    // Without this catch the rejection left cancellingId set, wedging Cancel
    // disabled with a spinner and no message. The wording is deliberately
    // uncertain: a rejection means the response never arrived, not that the work
    // did not happen, so a drop after cancel_lesson_atomic commits leaves the class
    // cancelled and the hours refunded while the student sees a failure. Claiming
    // it was not cancelled would be a false statement about a refund. Retrying is
    // safe either way - a second call returns LESSON_NOT_CANCELLABLE, so no double
    // refund is possible. The catch returns for the same reason the !result.success
    // branch does: router.refresh() below must run only on a confirmed success.
    try {
      const result = await cancelLessonAction(lessonId)

      if (!result.success) {
        setCancelError(result.error)
        setCancellingId(null)
        return
      }
      setShowCancelWarning(null)
      setCancellingId(null)
    } catch {
      setCancelError('Could not reach the server. Your class may or may not have been cancelled - please refresh the page to check before trying again.')
      setCancellingId(null)
      return
    }
    router.refresh()
  }

  function handleReschedule(lessonId: string) {
    router.push(`/student/book?reschedule=${lessonId}`)
  }

  const scheduledCount = scheduledLessons.length

  // Hide only after the dismissal is persisted - hiding on failure silently resurrects the
  // banner next load, and the banner remaining visible is itself the failure feedback.
  async function handleDismissBanner() {
    setIsDismissingBanner(true)
    try {
      const res = await fetch('/api/student/profile/dismiss-banner', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Failed to persist banner dismiss:', data.error ?? res.status)
        return
      }
      setShowProfileBanner(false)
    } catch (err) {
      console.error('Failed to persist banner dismiss:', err)
    } finally {
      setIsDismissingBanner(false)
    }
  }

  // Unlike the profile banner there is nothing to persist — the query string IS the
  // state, so dismissing strips it. router.replace rather than push so a Back
  // navigation cannot resurrect the banner either. The local flag hides it at once,
  // without waiting for the server render that drops the prop.
  function handleDismissNotice() {
    setNoticeDismissed(true)
    router.replace('/student/my-classes')
  }

  return (
    <div className="space-y-6">

      {/* Reschedule-unavailable notice — the book page sends a dead reschedule id here
          rather than letting it fall through to a fresh booking that charges hours.
          Stacks above the profile banner: both can be on screen at once. */}
      {notice === 'reschedule_unavailable' && !noticeDismissed && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#FFF8E8',
          borderLeft: '4px solid #FFB942',
          borderRadius: '8px',
          padding: '12px 16px',
          gap: '12px',
        }}>
          <p style={{ margin: 0, fontSize: '14px', color: '#111827', lineHeight: 1.5 }}>
            That class can no longer be rescheduled - it may have been cancelled or already changed. Your classes are up to date below.
          </p>
          <button
            onClick={handleDismissNotice}
            aria-label="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '18px',
              color: '#9ca3af',
              lineHeight: 1,
              padding: '0 4px',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Profile completion banner */}
      {showProfileBanner && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#FFF7ED',
          borderLeft: '4px solid #FF8303',
          borderRadius: '8px',
          padding: '12px 16px',
          gap: '12px',
        }}>
          <p style={{ margin: 0, fontSize: '14px', color: '#111827', lineHeight: 1.5 }}>
            Complete your profile to get the most out of your portal.{' '}
            <a
              href="/student/account"
              style={{ color: '#FF8303', fontWeight: 600, textDecoration: 'none' }}
            >
              Complete now →
            </a>
          </p>
          <button
            onClick={handleDismissBanner}
            disabled={isDismissingBanner}
            aria-label="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              cursor: isDismissingBanner ? 'wait' : 'pointer',
              fontSize: '18px',
              color: '#9ca3af',
              lineHeight: 1,
              padding: '0 4px',
              flexShrink: 0,
              opacity: isDismissingBanner ? 0.5 : 1,
            }}
          >
            {isDismissingBanner ? <Loader2 size={16} className="animate-spin" /> : '×'}
          </button>
        </div>
      )}

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', width: '100%' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
            My Classes
          </h1>
          <p style={{ fontSize: '14px', color: '#6b7280' }}>
            {scheduledCount} upcoming {scheduledCount === 1 ? 'class' : 'classes'}
          </p>
        </div>
        {/* Calendar subscription sits in the page header, not in the lessons
            list, so it renders on every page state - including the empty
            schedule, where a student can subscribe before booking anything. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <CalendarSubscriptionCard buttonRadius="6px" />
          <button
            onClick={() => router.push('/student/book')}
            onMouseEnter={() => setBookHovered(true)}
            onMouseLeave={() => setBookHovered(false)}
            className="flex items-center gap-1.5 rounded-md text-sm font-medium"
            style={{
              padding: '8px 16px',
              backgroundColor: bookHovered ? '#e67300' : '#FF8303',
              color: '#ffffff',
              border: 'none',
              cursor: 'pointer',
              transition: 'background-color 0.18s ease',
            }}
          >
            <Plus size={16} />
            Book a Class
          </button>
        </div>
      </div>

      {/* Cancel error banner */}
      {cancelError && (
        <div style={{
          padding: '10px 14px',
          backgroundColor: '#FFF3EE',
          border: '1px solid #FFD9C7',
          borderRadius: '8px',
          fontSize: '13px',
          color: '#FD5602',
        }}>
          {cancelError}
          <button
            onClick={() => setCancelError(null)}
            style={{ marginLeft: '12px', background: 'none', border: 'none', color: '#FD5602', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stat card row — the right panel owns hours-remaining / training-ends / exercises */}
      <div className="flex flex-wrap gap-4">
        <StatCard icon={CalendarDays} label="Upcoming Classes" value={scheduledCount} caption="booked ahead" />
        <StatCard icon={GraduationCap} label="Completed Classes" value={completedCount} caption="so far" />
        <StatCard icon={Clock} label="Hours Completed" value={formatHours(hoursCompleted)} caption="of learning so far" />
        <StatCard
          icon={Flame}
          label="Current Streak"
          value={streakWeeks}
          caption="weeks in a row"
          valueColor={streakWeeks === 0 ? '#9ca3af' : '#111827'}
        />
      </div>

      {scheduledLessons.length === 0 && (hoursRemaining != null && hoursRemaining <= 0 ? (
        /* No upcoming classes + zero hours — contact variant. Only shown when the
           balance is KNOWN to be zero; missing data falls through to Book a Class. */
        <div className="flex flex-col items-center text-center py-16">
          <EmptyStateCalendar />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">You&apos;ve used all your hours</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-[380px]">
            You have no hours left to book. Contact us to add more and keep learning.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {/* Same contact mechanism as the My Account "Need more hours?" button */}
            <Button asChild style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}>
              <a href="mailto:support@lingualinkonline.com">Contact us</a>
            </Button>
          </div>
        </div>
      ) : (
        /* No upcoming classes state — also the fallback when hoursRemaining is null
           (no training record): never show the contact variant on missing data. */
        <div className="flex flex-col items-center text-center py-16">
          <EmptyStateCalendar />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">No upcoming classes yet</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-[380px]">
            Book a time with your teacher to keep your training on track.
          </p>
          {mounted && hoursRemaining != null && hoursRemaining > 0 && trainingEndDate && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {formatHours(hoursRemaining)} remaining · training ends {formatEndDate(trainingEndDate)}
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}>
              <Link href="/student/book" prefetch={false}>
                <Plus />
                Book a Class
              </Link>
            </Button>
          </div>
        </div>
      ))}

      {/* ── Upcoming classes list ── */}
      {scheduledLessons.length > 0 && (
        <div>
          {/* Range filter over the agenda below. It is a view of the list only - the
              "Upcoming Classes" stat card and the count in the page header above both keep
              counting every upcoming class, filtered out or not. */}
          <div style={{ display: 'inline-flex', marginBottom: '16px' }}>
            {([
              ['week', 'This Week'],
              ['month', 'This Month'],
              ['all', 'All'],
            ] as const).map(([value, label], i, arr) => {
              const selected = rangeFilter === value
              return (
                <button
                  key={value}
                  onClick={() => setRangeFilter(value)}
                  style={{
                    fontSize: '13px',
                    padding: '6px 14px',
                    backgroundColor: selected ? '#FF8303' : 'white',
                    color: selected ? 'white' : '#374151',
                    border: '1px solid #d1d5db',
                    borderLeft: i === 0 ? '1px solid #d1d5db' : 'none',
                    borderTopLeftRadius: i === 0 ? '6px' : 0,
                    borderBottomLeftRadius: i === 0 ? '6px' : 0,
                    borderTopRightRadius: i === arr.length - 1 ? '6px' : 0,
                    borderBottomRightRadius: i === arr.length - 1 ? '6px' : 0,
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}>
            <h2 style={{ fontSize: '16px', fontWeight: '700', color: '#111827' }}>
              Upcoming Classes
            </h2>
          </div>

          {sortedDays.length === 0 ? (
            /* The window emptied the list. The no-classes-at-all empty state above stays
               gated on scheduledLessons.length === 0 and must not fire here: the student
               does have upcoming classes, just none inside the period they picked. */
            <p className="text-sm text-gray-500 text-center">No classes in this period.</p>
          ) : (
            <div className="space-y-5">
              {sortedDays.map((dayKey, dayIndex) => {
                const dayLessons = groupedByDate[dayKey]

                // Every calendar month in the list carries its header, the first one
                // included: two structurally identical months must not look different, and
                // in a flat agenda 31 Aug and 1 Sept are otherwise indistinguishable
                // neighbours. The first day has no previous day to compare against, so it
                // counts as a month change by definition. Months are compared on the day
                // keys, which getLocalDateKey already built in the student's timezone, so
                // the comparison and the text below it agree by construction.
                //
                // Gated on todayKey, like the filter: pre-mount the list is unfiltered and
                // no separator renders, so the server pass and the first client pass emit
                // the same markup.
                const showMonthSeparator =
                  todayKey !== null &&
                  (dayIndex === 0 || dayKey.slice(0, 7) !== sortedDays[dayIndex - 1].slice(0, 7))

                return (
                  <div key={dayKey}>
                    {showMonthSeparator && (
                      <p
                        style={{
                          // The first header already has the segmented control's gap above
                          // it; only a mid-list month break has to open a break of its own.
                          margin: dayIndex === 0 ? '0 0 10px' : '28px 0 10px',
                          paddingBottom: '6px',
                          paddingLeft: '2px',
                          borderBottom: '1px solid #E0DFDC',
                          fontSize: '13px',
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          color: '#111827',
                        }}
                      >
                        {formatMonth(dayLessons[0].scheduled_at, studentTimezone)}
                      </p>
                    )}
                    {/* Slim text divider, not a card and not a control: nothing collapses
                        here, so it carries no chevron and no lesson count. The mounted gate
                        is the one the old accordion heading used - the raw dateKey renders
                        until the effect sets mounted, so the server pass and the first
                        client pass emit the same string. formatDayDivider returns the bare
                        absolute date while todayKey is still null, so the text settles from
                        the key to a date to a relative label without ever mismatching. */}
                    <p
                      style={{
                        margin: '0 0 6px 2px',
                        fontSize: '11px',
                        fontWeight: '600',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: '#9ca3af',
                      }}
                    >
                      {mounted ? formatDayDivider(dayLessons[0].scheduled_at, studentTimezone, dayKey, todayKey) : dayKey}
                    </p>

                    <div className="card-elevated" style={{ overflow: 'hidden' }}>
                      {dayLessons.map((lesson, i) => (
                        <LessonRow
                          key={lesson.id}
                          lesson={lesson}
                          studentTimezone={studentTimezone}
                          mounted={mounted}
                          now={now}
                          isFirst={i === 0}
                          isNext={lesson.id === nextId}
                          lastFeedback={lesson.id === nextId ? lastFeedback : null}
                          showDate={false}
                          cancellingId={cancellingId}
                          showCancelWarning={showCancelWarning}
                          onReschedule={handleReschedule}
                          onCancel={handleCancel}
                          onDismissWarning={() => setShowCancelWarning(null)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
