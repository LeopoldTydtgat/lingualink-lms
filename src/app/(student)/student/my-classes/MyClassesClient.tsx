'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  User,
  ChevronDown,
  ChevronUp,
  Video,
  RefreshCw,
  XCircle,
  Plus,
} from 'lucide-react'
import { cancelLessonAction } from './actions'

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
  teacher_id: string
  training_id: string
  teacher: Teacher | null
}

interface MyClassesClientProps {
  lessons: Lesson[]
  lastFeedback: string | null
  studentTimezone: string
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

// Returns YYYY-MM-DD in the student's local timezone — used to group lessons by day
function getLocalDateKey(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(isoString)) // en-CA gives YYYY-MM-DD format
}

function formatCountdown(secondsUntil: number): string {
  if (secondsUntil <= 0) return 'Now'
  const days = Math.floor(secondsUntil / 86400)
  const hours = Math.floor((secondsUntil % 86400) / 3600)
  const minutes = Math.floor((secondsUntil % 3600) / 60)
  const seconds = secondsUntil % 60

  if (days > 0) {
    return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getSecondsUntil(isoString: string, now: number): number {
  return Math.max(0, Math.floor((new Date(isoString).getTime() - now) / 1000))
}

function isJoinable(isoString: string, now: number): boolean {
  return getSecondsUntil(isoString, now) <= 900 // 15 minutes
}

function isWithin24Hours(isoString: string, now: number): boolean {
  return getSecondsUntil(isoString, now) < 86400
}

export default function MyClassesClient({
  lessons,
  lastFeedback,
  studentTimezone,
}: MyClassesClientProps) {
  const router = useRouter()

  const [now, setNow] = useState(0) // 0 until mounted — avoids hydration mismatch
  const [mounted, setMounted] = useState(false)
  const [hideCancelled, setHideCancelled] = useState(false)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [showCancelWarning, setShowCancelWarning] = useState<string | null>(null)

  useEffect(() => {
    const currentNow = Date.now()
    setNow(currentNow)
    setMounted(true)

    // Expand all day groups by default
    const keys = new Set<string>()
    lessons.forEach((l) => keys.add(getLocalDateKey(l.scheduled_at, studentTimezone)))
    setExpandedDays(keys)

    // Tick every second for countdowns
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // First scheduled lesson gets the prominent next class card
  const nextLesson = lessons.find((l) => l.status === 'scheduled') ?? null

  // All other lessons go in the list below
  const listLessons = lessons.filter((l) => {
    if (nextLesson && l.id === nextLesson.id) return false
    if (hideCancelled && l.status === 'cancelled') return false
    return true
  })

  // Group list lessons by local date
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
      return
    }
    setCancellingId(lessonId)
    setShowCancelWarning(null)

    // Server action handles cancellation + hours refund logic atomically.
    // If >24hrs before class: hours_consumed is decremented (refund).
    // If <24hrs before class: hours_consumed is unchanged (no refund).
    const result = await cancelLessonAction(lessonId)

    setCancellingId(null)
    if (result.error) {
      console.error('Cancel failed:', result.error)
    }
    router.refresh()
  }

  const scheduledCount = lessons.filter((l) => l.status === 'scheduled').length

  return (
    <div style={{ maxWidth: '800px' }}>

      {/* Page header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '24px',
      }}>
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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 18px',
            backgroundColor: '#FF8303',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
          }}
        >
          <Plus size={16} />
          Book a Class
        </button>
      </div>

      {/* ── Next class card ── */}
      {nextLesson ? (
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          padding: '24px',
          marginBottom: '28px',
        }}>
          <p style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#FF8303',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '16px',
          }}>
            Next Class
          </p>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>

            {/* Teacher photo */}
            <div style={{ flexShrink: 0 }}>
              {nextLesson.teacher?.photo_url ? (
                <Image
                  src={nextLesson.teacher.photo_url}
                  alt={nextLesson.teacher.full_name}
                  width={56}
                  height={56}
                  style={{ borderRadius: '50%', border: '2px solid #E0DFDC' }}
                />
              ) : (
                <div style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  border: '2px solid #E0DFDC',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <User size={24} color="#9ca3af" />
                </div>
              )}
            </div>

            {/* Class details */}
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '17px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
                {nextLesson.teacher?.full_name ?? 'Teacher'}
              </p>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '2px' }}>
                {mounted ? formatDate(nextLesson.scheduled_at, studentTimezone) : ''}
              </p>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '16px' }}>
                {mounted ? formatTime(nextLesson.scheduled_at, studentTimezone) : ''} · {nextLesson.duration_minutes} min
              </p>

              {/* Countdown */}
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                backgroundColor: '#fff7ed',
                borderRadius: '8px',
                padding: '8px 16px',
                marginBottom: '16px',
              }}>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: '#FF8303',
                }} />
                <span style={{
                  fontSize: '22px',
                  fontWeight: '700',
                  color: '#FF8303',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {mounted ? formatCountdown(getSecondsUntil(nextLesson.scheduled_at, now)) : '--:--:--'}
                </span>
              </div>

              {/* Join button */}
              <div style={{ marginBottom: '16px' }}>
                {nextLesson.teams_join_url ? (
                  <a
                    href={mounted && isJoinable(nextLesson.scheduled_at, now) ? nextLesson.teams_join_url : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 20px',
                      backgroundColor: mounted && isJoinable(nextLesson.scheduled_at, now) ? '#111827' : '#E0DFDC',
                      color: mounted && isJoinable(nextLesson.scheduled_at, now) ? '#ffffff' : '#9ca3af',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: '600',
                      textDecoration: 'none',
                      cursor: mounted && isJoinable(nextLesson.scheduled_at, now) ? 'pointer' : 'default',
                      pointerEvents: mounted && isJoinable(nextLesson.scheduled_at, now) ? 'auto' : 'none',
                    }}
                  >
                    <Video size={16} />
                    {mounted && isJoinable(nextLesson.scheduled_at, now)
                      ? 'Join Class'
                      : 'Join Class (available 15 min before)'}
                  </a>
                ) : (
                  <span style={{ fontSize: '13px', color: '#9ca3af' }}>
                    Meeting link not yet available
                  </span>
                )}
              </div>

              {/* Reschedule and Cancel */}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => router.push(`/student/book?reschedule=${nextLesson.id}`)}
                  disabled={mounted && isWithin24Hours(nextLesson.scheduled_at, now)}
                  title={
                    mounted && isWithin24Hours(nextLesson.scheduled_at, now)
                      ? 'Reschedule not available within 24 hours of class'
                      : ''
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '7px 14px',
                    backgroundColor: 'transparent',
                    border: '1px solid #E0DFDC',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: mounted && isWithin24Hours(nextLesson.scheduled_at, now) ? '#9ca3af' : '#4b5563',
                    cursor: mounted && isWithin24Hours(nextLesson.scheduled_at, now) ? 'not-allowed' : 'pointer',
                  }}
                >
                  <RefreshCw size={13} />
                  Reschedule
                </button>

                <button
                  onClick={() =>
                    mounted && handleCancel(nextLesson.id, isWithin24Hours(nextLesson.scheduled_at, now))
                  }
                  disabled={cancellingId === nextLesson.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '7px 14px',
                    backgroundColor: 'transparent',
                    border: '1px solid #E0DFDC',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#4b5563',
                    cursor: cancellingId === nextLesson.id ? 'not-allowed' : 'pointer',
                  }}
                >
                  <XCircle size={13} />
                  {cancellingId === nextLesson.id ? 'Cancelling...' : 'Cancel'}
                </button>
              </div>

              {/* 24-hour cancel warning — shown before confirming */}
              {showCancelWarning === nextLesson.id && (
                <div style={{
                  marginTop: '12px',
                  padding: '14px 16px',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '8px',
                }}>
                  <p style={{ fontSize: '13px', fontWeight: '600', color: '#dc2626', marginBottom: '4px' }}>
                    Warning
                  </p>
                  <p style={{ fontSize: '13px', color: '#dc2626', marginBottom: '12px' }}>
                    Cancelling within 24 hours means your hours will not be refunded. Are you sure?
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleCancel(nextLesson.id, true)}
                      style={{
                        padding: '6px 14px',
                        backgroundColor: '#dc2626',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: 'pointer',
                      }}
                    >
                      Yes, cancel
                    </button>
                    <button
                      onClick={() => setShowCancelWarning(null)}
                      style={{
                        padding: '6px 14px',
                        backgroundColor: 'transparent',
                        border: '1px solid #E0DFDC',
                        borderRadius: '6px',
                        fontSize: '13px',
                        fontWeight: '500',
                        color: '#4b5563',
                        cursor: 'pointer',
                      }}
                    >
                      Go back
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* About This Class — recap from previous lesson's report */}
          {lastFeedback && (
            <div style={{
              marginTop: '20px',
              paddingTop: '20px',
              borderTop: '1px solid #E0DFDC',
            }}>
              <p style={{
                fontSize: '12px',
                fontWeight: '600',
                color: '#9ca3af',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '8px',
              }}>
                About This Class
              </p>
              <p style={{ fontSize: '14px', color: '#4b5563', lineHeight: '1.6' }}>
                {lastFeedback}
              </p>
            </div>
          )}
        </div>
      ) : (
        /* No upcoming classes state */
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          padding: '40px 24px',
          textAlign: 'center',
          marginBottom: '28px',
        }}>
          <p style={{ fontSize: '15px', color: '#6b7280', marginBottom: '16px' }}>
            You have no upcoming classes.
          </p>
          <button
            onClick={() => router.push('/student/book')}
            style={{
              padding: '10px 20px',
              backgroundColor: '#FF8303',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Book Your Next Class
          </button>
        </div>
      )}

      {/* ── Upcoming classes list ── */}
      {sortedDays.length > 0 && (
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
                onChange={(e) => setHideCancelled(e.target.checked)}
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
                    backgroundColor: '#f3f4f6',
                    border: 'none',
                    borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#374151',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span>{dayLabel} — {count} {count === 1 ? 'class' : 'classes'}</span>
                  {isExpanded
                    ? <ChevronUp size={16} color="#9ca3af" />
                    : <ChevronDown size={16} color="#9ca3af" />
                  }
                </button>

                {/* Lessons within this day */}
                {isExpanded && dayLessons.map((lesson, i) => {
                  const isCancelled = lesson.status === 'cancelled'
                  const within24 = mounted && !isCancelled && isWithin24Hours(lesson.scheduled_at, now)
                  const secondsUntil = mounted ? getSecondsUntil(lesson.scheduled_at, now) : 0
                  const isLast = i === dayLessons.length - 1

                  return (
                    <div key={lesson.id}>
                      <div
                        style={{
                          backgroundColor: '#ffffff',
                          border: '1px solid #E0DFDC',
                          borderTop: 'none',
                          borderRadius: isLast ? '0 0 8px 8px' : '0',
                          padding: '14px 16px',
                          opacity: isCancelled ? 0.6 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

                          {/* Teacher photo */}
                          <div style={{ flexShrink: 0 }}>
                            {lesson.teacher?.photo_url ? (
                              <Image
                                src={lesson.teacher.photo_url}
                                alt={lesson.teacher.full_name}
                                width={36}
                                height={36}
                                style={{ borderRadius: '50%', border: '1px solid #E0DFDC' }}
                              />
                            ) : (
                              <div style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '50%',
                                backgroundColor: '#f3f4f6',
                                border: '1px solid #E0DFDC',
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
                                  backgroundColor: '#fef2f2',
                                  color: '#dc2626',
                                  borderRadius: '4px',
                                }}>
                                  Cancelled
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: '13px', color: '#6b7280' }}>
                              {mounted ? formatTime(lesson.scheduled_at, studentTimezone) : ''} · {lesson.duration_minutes} min
                            </span>
                          </div>

                          {/* Countdown */}
                          {!isCancelled && mounted && (
                            <span style={{
                              fontSize: '13px',
                              fontWeight: '600',
                              color: '#FF8303',
                              fontVariantNumeric: 'tabular-nums',
                              flexShrink: 0,
                            }}>
                              {formatCountdown(secondsUntil)}
                            </span>
                          )}

                          {/* Reschedule / Cancel buttons */}
                          {!isCancelled && (
                            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                              <button
                                onClick={() => router.push(`/student/book?reschedule=${lesson.id}`)}
                                disabled={!!within24}
                                title={within24 ? 'Reschedule not available within 24 hours of class' : ''}
                                style={{
                                  padding: '5px 10px',
                                  backgroundColor: 'transparent',
                                  border: '1px solid #E0DFDC',
                                  borderRadius: '6px',
                                  fontSize: '12px',
                                  fontWeight: '500',
                                  color: within24 ? '#9ca3af' : '#4b5563',
                                  cursor: within24 ? 'not-allowed' : 'pointer',
                                }}
                              >
                                Reschedule
                              </button>
                              <button
                                onClick={() => handleCancel(lesson.id, !!within24)}
                                disabled={cancellingId === lesson.id}
                                style={{
                                  padding: '5px 10px',
                                  backgroundColor: 'transparent',
                                  border: '1px solid #E0DFDC',
                                  borderRadius: '6px',
                                  fontSize: '12px',
                                  fontWeight: '500',
                                  color: '#4b5563',
                                  cursor: cancellingId === lesson.id ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {cancellingId === lesson.id ? '...' : 'Cancel'}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* 24-hour cancel warning — inline in list */}
                        {showCancelWarning === lesson.id && (
                          <div style={{
                            marginTop: '10px',
                            padding: '10px 14px',
                            backgroundColor: '#fef2f2',
                            border: '1px solid #fecaca',
                            borderRadius: '6px',
                          }}>
                            <p style={{ fontSize: '13px', color: '#dc2626', marginBottom: '8px' }}>
                              Cancelling within 24 hours means your hours will not be refunded. Are you sure?
                            </p>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button
                                onClick={() => handleCancel(lesson.id, true)}
                                style={{
                                  padding: '5px 12px',
                                  backgroundColor: '#dc2626',
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
                                onClick={() => setShowCancelWarning(null)}
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
                        )}

                        {/* Cancellation reason if present */}
                        {isCancelled && lesson.cancellation_reason && (
                          <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
                            Reason: {lesson.cancellation_reason}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
