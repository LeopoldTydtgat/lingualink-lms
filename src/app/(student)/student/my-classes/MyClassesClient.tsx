'use client'

import { useState, useEffect, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  User,
  ChevronDown,
  ChevronUp,
  Plus,
  CalendarDays,
  GraduationCap,
  Clock,
  Flame,
} from 'lucide-react'
import { cancelLessonAction } from './actions'
import { formatCompoundCountdown } from '@/lib/lessons/countdown'
import { isCancelledStatus } from '@/lib/billing/billability'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { Button } from '@/components/ui/button'
import { EmptyStateCalendar } from '@/components/EmptyStateCalendar'

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
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

function formatEndDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(isoDate))
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

// ── Shared lesson row — used by upcoming day groups and the cancelled section ──
function LessonRow({
  lesson,
  studentTimezone,
  mounted,
  now,
  isLast,
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
  isLast: boolean
  showDate: boolean
  cancellingId: string | null
  showCancelWarning: string | null
  onReschedule: (id: string) => void
  onCancel: (id: string, within24: boolean) => void
  onDismissWarning: () => void
}) {
  const isCancelled = isCancelledStatus(lesson.status)
  const cancelLabel = getCancellationLabel(lesson, 'student')
  const within24 = mounted && !isCancelled && isWithin24Hours(lesson.scheduled_at, now)
  const secondsUntil = mounted ? getSecondsUntil(lesson.scheduled_at, now) : 0
  const isCancelling = cancellingId === lesson.id

  const timeText = showDate
    ? `${formatDate(lesson.scheduled_at, studentTimezone)} · ${formatTimeRange(lesson.scheduled_at, studentTimezone, lesson.duration_minutes)}`
    : formatTimeRange(lesson.scheduled_at, studentTimezone, lesson.duration_minutes)

  return (
    <div>
      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderTop: 'none',
          borderRadius: isLast ? '0 0 8px 8px' : '0',
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
            </div>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>
              {mounted ? timeText : ''} · {lesson.duration_minutes} min
            </span>
          </div>

          {/* Countdown */}
          {!isCancelled && mounted && (
            <span className="font-mono text-sm" style={{ color: '#FF8303', flexShrink: 0 }}>
              {formatCompoundCountdown(secondsUntil)}
            </span>
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
                {isCancelling ? '...' : 'Cancel'}
              </SecondaryButton>
            </div>
          )}
        </div>

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
}: MyClassesClientProps) {
  const router = useRouter()

  const [showProfileBanner, setShowProfileBanner] = useState<boolean>(!profileCompleted && !bannerDismissed)
  const [now, setNow] = useState(0) // 0 until mounted — avoids hydration mismatch
  const [mounted, setMounted] = useState(false)
  const [hideCancelled, setHideCancelled] = useState(false)
  const [cancelledSectionExpanded, setCancelledSectionExpanded] = useState(true)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [showCancelWarning, setShowCancelWarning] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [bookHovered, setBookHovered] = useState(false)
  const [joinHovered, setJoinHovered] = useState(false)

  useEffect(() => {
    const currentNow = Date.now()
    setNow(currentNow)
    setMounted(true)

    try {
      const stored = localStorage.getItem('lingualink_student_hide_cancelled')
      if (stored === 'true') setHideCancelled(true)
    } catch {}

    try {
      const stored = localStorage.getItem('lingualink_student_cancelled_section_expanded')
      if (stored === 'false') setCancelledSectionExpanded(false)
    } catch {}

    // Expand all day groups by default
    const keys = new Set<string>()
    lessons.forEach((l) => keys.add(getLocalDateKey(l.scheduled_at, studentTimezone)))
    setExpandedDays(keys)

    // Tick every second for countdowns
    const interval = setInterval(() => setNow(Date.now()), 1000)
    // Catch external changes (e.g. teacher or admin cancellations)
    const pollInterval = setInterval(() => router.refresh(), 30_000)
    return () => {
      clearInterval(interval)
      clearInterval(pollInterval)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // First scheduled lesson gets the prominent next class hero card
  const nextLesson = lessons.find((l) => l.status === 'scheduled') ?? null

  // All scheduled lessons (for counts) and the grouped list (which excludes the hero)
  const scheduledLessons = lessons.filter((l) => l.status === 'scheduled')
  const listLessons = scheduledLessons.filter((l) => l.id !== nextLesson?.id)

  // Cancelled lessons for the separate collapsed section
  const cancelledLessons = lessons
    .filter((l) => isCancelledStatus(l.status))
    .sort((a, b) => {
      const ta = a.cancelled_at ?? a.scheduled_at
      const tb = b.cancelled_at ?? b.scheduled_at
      return new Date(tb).getTime() - new Date(ta).getTime()
    })

  // Group upcoming (non-hero) lessons by local date
  const groupedByDate: Record<string, Lesson[]> = {}
  listLessons.forEach((lesson) => {
    const key = getLocalDateKey(lesson.scheduled_at, studentTimezone)
    if (!groupedByDate[key]) groupedByDate[key] = []
    groupedByDate[key].push(lesson)
  })
  const sortedDays = Object.keys(groupedByDate).sort()

  function toggleDay(key: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

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
    const result = await cancelLessonAction(lessonId)

    if (!result.success) {
      setCancelError(result.error)
      setCancellingId(null)
      return
    }
    setShowCancelWarning(null)
    setCancellingId(null)
    router.refresh()
  }

  function handleReschedule(lessonId: string) {
    router.push(`/student/book?reschedule=${lessonId}`)
  }

  function handleCancelledSectionToggle() {
    const next = !cancelledSectionExpanded
    setCancelledSectionExpanded(next)
    try { localStorage.setItem('lingualink_student_cancelled_section_expanded', String(next)) } catch {}
  }

  const scheduledCount = scheduledLessons.length

  async function handleDismissBanner() {
    try {
      const res = await fetch('/api/student/profile/dismiss-banner', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Failed to persist banner dismiss:', data.error ?? res.status)
      }
    } catch (err) {
      console.error('Failed to persist banner dismiss:', err)
    }
    setShowProfileBanner(false)
  }

  // Next class hero derivations
  const nextWithin24 = !!nextLesson && mounted && isWithin24Hours(nextLesson.scheduled_at, now)
  const nextSeconds = nextLesson && mounted ? getSecondsUntil(nextLesson.scheduled_at, now) : 0
  const nextCancelling = !!nextLesson && cancellingId === nextLesson.id
  const canJoinNext =
    !!nextLesson &&
    mounted &&
    !!nextLesson.teams_join_url &&
    isLessonJoinable(nextLesson.scheduled_at, nextLesson.duration_minutes, nextLesson.status, now)

  return (
    <div className="space-y-6">

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

      {/* Next class hero card */}
      {nextLesson && (
        <div
          className="shadow-sm"
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid #f3f4f6',
            borderLeft: '3px solid #FF8303',
            padding: '20px 24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>

            {/* Teacher photo */}
            <div style={{ flexShrink: 0, width: '64px', height: '64px', borderRadius: '50%', overflow: 'hidden', border: '1px solid #E0DFDC' }}>
              {nextLesson.teacher?.photo_url ? (
                <Image
                  src={nextLesson.teacher.photo_url}
                  alt={nextLesson.teacher.full_name}
                  width={64}
                  height={64}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <User size={20} color="#9ca3af" />
                </div>
              )}
            </div>

            {/* Name, NEXT pill, date + time */}
            <div style={{ flex: 1, minWidth: '200px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '16px', fontWeight: '700', color: '#111827' }}>
                  {nextLesson.teacher?.full_name ?? 'Teacher'}
                </span>
                <span style={{
                  fontSize: '10px',
                  fontWeight: '700',
                  letterSpacing: '0.06em',
                  padding: '2px 8px',
                  backgroundColor: '#FF8303',
                  color: '#ffffff',
                  borderRadius: '4px',
                }}>
                  NEXT
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: '12px',
                  fontWeight: '600',
                  padding: '3px 10px',
                  backgroundColor: '#FFF3E0',
                  color: '#FF8303',
                  borderRadius: '6px',
                }}>
                  {mounted ? formatDate(nextLesson.scheduled_at, studentTimezone) : ''}
                </span>
                <span style={{ fontSize: '13px', color: '#6b7280' }}>
                  {mounted ? formatTimeRange(nextLesson.scheduled_at, studentTimezone, nextLesson.duration_minutes) : ''} · {nextLesson.duration_minutes} min
                </span>
              </div>
            </div>

            {/* Countdown */}
            <div className="font-mono text-base" style={{ textAlign: 'right', flexShrink: 0, color: '#FF8303', lineHeight: 1 }}>
              {mounted ? formatCompoundCountdown(nextSeconds) : '—'}
            </div>
          </div>

          {/* About This Class — most recent report feedback */}
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

          {/* Actions */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
            {canJoinNext ? (
              <a
                href={nextLesson.teams_join_url!}
                target="_blank"
                rel="noopener noreferrer"
                onMouseEnter={() => setJoinHovered(true)}
                onMouseLeave={() => setJoinHovered(false)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 18px',
                  backgroundColor: joinHovered ? '#e67300' : '#FF8303',
                  color: '#ffffff',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '600',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  transition: 'background-color 0.18s ease',
                }}
              >
                Join Class
              </a>
            ) : (
              <span
                title="Available 10 minutes before class"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 18px',
                  backgroundColor: '#E5E7EB',
                  color: '#9CA3AF',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'not-allowed',
                }}
              >
                Join Class
              </span>
            )}
            <SecondaryButton
              onClick={() => handleReschedule(nextLesson.id)}
              disabled={nextWithin24}
              title={nextWithin24 ? 'Reschedule not available within 24 hours of class' : ''}
              padding="8px 14px"
              fontSize="13px"
            >
              Reschedule
            </SecondaryButton>
            <SecondaryButton
              onClick={() => handleCancel(nextLesson.id, nextWithin24)}
              disabled={nextCancelling}
              padding="8px 14px"
              fontSize="13px"
            >
              {nextCancelling ? '...' : 'Cancel'}
            </SecondaryButton>
          </div>

          {/* 24-hour cancel warning for the hero */}
          {showCancelWarning === nextLesson.id && (
            <CancelWarning
              onConfirm={() => handleCancel(nextLesson.id, true)}
              onDismiss={() => setShowCancelWarning(null)}
            />
          )}
        </div>
      )}

      {!nextLesson && (hoursRemaining != null && hoursRemaining <= 0 ? (
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

      {/* ── Upcoming and cancelled classes list ── */}
      {(listLessons.length > 0 || cancelledLessons.length > 0) && (
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}>
            <h2 style={{ fontSize: '16px', fontWeight: '700', color: '#111827' }}>
              Upcoming Classes
            </h2>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              color: '#6b7280',
              cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={hideCancelled}
                onChange={(e) => {
                  const checked = e.target.checked
                  setHideCancelled(checked)
                  try {
                    localStorage.setItem('lingualink_student_hide_cancelled', String(checked))
                  } catch {}
                }}
                style={{ accentColor: '#FF8303' }}
              />
              Hide cancelled
            </label>
          </div>

          {sortedDays.map((dayKey) => {
            const dayLessons = groupedByDate[dayKey]
            const isExpanded = expandedDays.has(dayKey)
            const count = dayLessons.length
            const dayLabel = mounted
              ? new Intl.DateTimeFormat('en-GB', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  timeZone: studentTimezone,
                }).format(new Date(dayLessons[0].scheduled_at))
              : dayKey

            return (
              <div key={dayKey} style={{ marginBottom: '8px' }}>

                {/* Day group header — click to expand/collapse */}
                <button
                  onClick={() => toggleDay(dayKey)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 16px',
                    backgroundColor: '#f9fafb',
                    border: '1px solid #E0DFDC',
                    borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#374151',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {dayLabel}
                    <span style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      padding: '1px 8px',
                      backgroundColor: '#f3f4f6',
                      color: '#4b5563',
                      borderRadius: '10px',
                    }}>
                      {count}
                    </span>
                  </span>
                  {isExpanded
                    ? <ChevronUp size={16} color="#9ca3af" />
                    : <ChevronDown size={16} color="#9ca3af" />
                  }
                </button>

                {/* Lessons within this day */}
                {isExpanded && dayLessons.map((lesson, i) => (
                  <LessonRow
                    key={lesson.id}
                    lesson={lesson}
                    studentTimezone={studentTimezone}
                    mounted={mounted}
                    now={now}
                    isLast={i === dayLessons.length - 1}
                    showDate={false}
                    cancellingId={cancellingId}
                    showCancelWarning={showCancelWarning}
                    onReschedule={handleReschedule}
                    onCancel={handleCancel}
                    onDismissWarning={() => setShowCancelWarning(null)}
                  />
                ))}
              </div>
            )
          })}

          {/* ── Cancelled section ── */}
          {!hideCancelled && cancelledLessons.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <button
                onClick={handleCancelledSectionToggle}
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 16px',
                  backgroundColor: '#f9fafb',
                  border: '1px solid #E0DFDC',
                  borderRadius: cancelledSectionExpanded ? '8px 8px 0 0' : '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  color: '#374151',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Cancelled
                  <span style={{
                    fontSize: '12px',
                    fontWeight: '600',
                    padding: '1px 8px',
                    backgroundColor: '#f3f4f6',
                    color: '#4b5563',
                    borderRadius: '10px',
                  }}>
                    {cancelledLessons.length}
                  </span>
                </span>
                {cancelledSectionExpanded
                  ? <ChevronUp size={16} color="#9ca3af" />
                  : <ChevronDown size={16} color="#9ca3af" />
                }
              </button>

              {cancelledSectionExpanded && cancelledLessons.map((lesson, i) => (
                <LessonRow
                  key={lesson.id}
                  lesson={lesson}
                  studentTimezone={studentTimezone}
                  mounted={mounted}
                  now={now}
                  isLast={i === cancelledLessons.length - 1}
                  showDate={true}
                  cancellingId={cancellingId}
                  showCancelWarning={showCancelWarning}
                  onReschedule={handleReschedule}
                  onCancel={handleCancel}
                  onDismissWarning={() => setShowCancelWarning(null)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
