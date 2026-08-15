// src/components/student/layout/StudentRightPanel.tsx
// No Help & Support section here. The ChatWidget bubble that once replaced it is
// teacher-portal only — it is mounted in (dashboard)/layout.tsx and nowhere in the
// student layout, so nothing in this panel should reference it.
'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Clock, Hourglass, Pencil, Flag, Video, BookOpen, Trophy } from 'lucide-react'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { describeLessonCountdown, formatRemainingCountdown, formatHeroCountdown } from '@/lib/lessons/countdown'
import { utcInstantToTzParts } from '@/lib/utils/timezone'

interface NextLesson {
  id: string
  scheduled_at: string
  teams_join_url: string | null
  duration_minutes: number
  status: string
}

interface StudentRightPanelProps {
  studentId: string
  studentTimezone: string
  nextLesson: NextLesson | null
  teacherName: string | null
  hoursRemaining: number
  totalHours: number
  trainingEndDate: string | null
  assignedExercises: number
  completedExercises: number
  streakWeeks: number
}

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

// Format: "Mon 13 Jul, 10:30 – 11:30" in the student's account timezone.
// Built from utcInstantToTzParts (same helper as the teacher schedule) — never
// toLocaleTimeString(), so server and client render identical text.
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDateTimeRange(isoString: string, durationMinutes: number, timezone: string): string {
  const startMs = new Date(isoString).getTime()
  const s = utcInstantToTzParts(isoString, timezone)
  const e = utcInstantToTzParts(new Date(startMs + durationMinutes * 60 * 1000), timezone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${WEEKDAY_NAMES[s.weekday]} ${pad(s.day)} ${MONTH_NAMES[s.month - 1]}, ${pad(s.hour)}:${pad(s.minute)} – ${pad(e.hour)}:${pad(e.minute)}`
}

export default function StudentRightPanel({
  studentId: _studentId,
  studentTimezone,
  nextLesson,
  teacherName,
  hoursRemaining,
  totalHours,
  trainingEndDate,
  assignedExercises,
  completedExercises,
  streakWeeks,
}: StudentRightPanelProps) {
  const [now, setNow] = useState(0)
  const [mounted, setMounted] = useState(false)
  const [joinHovered, setJoinHovered] = useState(false)
  const [exercisesHovered, setExercisesHovered] = useState(false)

  const panelRef = useRef<HTMLElement>(null)

  const handleWheel = (e: React.WheelEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel) return
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight
    const atTop = panel.scrollTop === 0
    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return
    document.querySelector('main')?.scrollBy({ top: e.deltaY })
  }

  useEffect(() => {
    setNow(Date.now())
    setMounted(true)
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const secondsUntilNext = nextLesson
    ? Math.max(0, Math.floor((new Date(nextLesson.scheduled_at).getTime() - now) / 1000))
    : null

  const lessonStartMs = nextLesson ? new Date(nextLesson.scheduled_at).getTime() : null
  const classEndMs = lessonStartMs !== null && nextLesson
    ? lessonStartMs + nextLesson.duration_minutes * 60 * 1000
    : null
  // Liveness comes from the shared half-open [start, end) window in
  // describeLessonCountdown, the same definition the my-classes cards use, so this
  // panel's heading can never disagree with the card beside it. Only `live` is taken:
  // the hero below uses formatHeroCountdown (zero-padded HH:MM:SS).
  const isLive = mounted && lessonStartMs !== null && classEndMs !== null
    ? describeLessonCountdown(lessonStartMs, classEndMs, now).live
    : false
  const classEnded = mounted && classEndMs !== null && now >= classEndMs
  // One joinability read per render instead of eight inline recomputations, all of
  // which used identical arguments.
  const isJoinable = mounted && nextLesson !== null
    && isLessonJoinable(nextLesson.scheduled_at, nextLesson.duration_minutes, nextLesson.status, now)
  const remainingSeconds = classEndMs !== null
    ? Math.max(0, Math.floor((classEndMs - now) / 1000))
    : 0

  const exercisePercent = assignedExercises > 0
    ? Math.round((completedExercises / assignedExercises) * 100)
    : 0

  const lowHours = hoursRemaining < 2
  const hoursUsedPercent = totalHours > 0 ? Math.round(((totalHours - hoursRemaining) / totalHours) * 100) : 0

  return (
    <aside
      ref={panelRef}
      onWheel={handleWheel}
      className="thin-scroll"
      style={{
        width: '288px',
        minWidth: '288px',
        backgroundColor: '#F7F8FA',
        borderLeft: '1px solid #E5E7EB',
        padding: '16px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        flexShrink: 0,
      }}
    >

      {/* ── Next Class ── */}
      <div className="shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', borderRadius: '12px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
          <Clock size={14} color="#FF8303" style={{ flexShrink: 0 }} />
          <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>{isLive ? 'In Class' : 'Next Class'}</p>
        </div>

        {nextLesson ? (
          <>
            {mounted && secondsUntilNext !== null && classEnded ? (
              <p style={{ fontSize: '14px', fontWeight: '600', color: '#111827', lineHeight: '1.3', marginBottom: '4px' }}>
                Class has ended
              </p>
            ) : mounted && secondsUntilNext !== null && isLive ? (
              <p style={{ fontSize: '14px', fontWeight: '600', lineHeight: '1.3', marginBottom: '4px', color: '#FF8303' }}>
                In class: {formatRemainingCountdown(remainingSeconds)} remaining
              </p>
            ) : (
              <p style={{
                fontSize: '22px',
                fontWeight: '700',
                color: '#111827',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: '1.2',
                marginBottom: '4px',
              }}>
                {mounted && secondsUntilNext !== null
                  ? formatHeroCountdown(secondsUntilNext)
                  : '--:--:--'}
              </p>
            )}
            <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
              {mounted ? formatDateTimeRange(nextLesson.scheduled_at, nextLesson.duration_minutes, studentTimezone) : ''}
            </p>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '1px' }}>
              {nextLesson.duration_minutes} min class
            </p>
            {teacherName && (
              <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '1px' }}>
                with {teacherName}
              </p>
            )}

            <div style={{ marginTop: '10px' }}>
              {nextLesson.teams_join_url ? (
                <>
                  <a
                    href={isJoinable ? nextLesson.teams_join_url : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={() => setJoinHovered(true)}
                    onMouseLeave={() => setJoinHovered(false)}
                    onClick={() => {
                      // Fire-and-forget student join-click logging. Guarded to the
                      // joinable state only, and never awaited / never throws —
                      // logging must not block or break opening Teams.
                      if (!isJoinable || !nextLesson.teams_join_url) return
                      fetch('/api/join-click', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ lesson_id: nextLesson.id }),
                        keepalive: true,
                      }).catch(() => {})
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      gap: '8px',
                      padding: '7px 12px',
                      backgroundColor: isJoinable
                        ? (joinHovered ? '#FF8303' : '#ffffff')
                        : '#E0DFDC',
                      color: isJoinable
                        ? (joinHovered ? '#ffffff' : '#FF8303')
                        : '#9ca3af',
                      border: isJoinable
                        ? '1.5px solid #FF8303'
                        : 'none',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: '600',
                      textAlign: 'center',
                      textDecoration: 'none',
                      cursor: isJoinable
                        ? 'pointer'
                        : 'default',
                      pointerEvents: isJoinable
                        ? 'auto'
                        : 'none',
                      transition: 'background-color 0.18s ease, color 0.18s ease',
                    }}
                  >
                    <Video size={14} />
                    Join Class
                  </a>
                  {!isJoinable && !classEnded && (
                    <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', marginTop: '6px' }}>
                      Opens 10 min before class
                    </p>
                  )}
                </>
              ) : (
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                  Link not yet available
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '22px', fontWeight: '700', color: '#111827' }}>--</p>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
              No upcoming classes
            </p>
          </>
        )}
      </div>

      {/* ── My Training ── */}
      <div className="shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', borderRadius: '12px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
          <Hourglass size={14} color="#FF8303" style={{ flexShrink: 0 }} />
          <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>My Training</p>
        </div>

        <p style={{
          fontSize: '18px',
          fontWeight: '700',
          color: lowHours ? '#FD5602' : '#111827',
          marginBottom: '2px',
        }}>
          {formatHours(hoursRemaining)}
          <span style={{ fontSize: '12px', fontWeight: '400', color: '#9ca3af' }}> remaining</span>
        </p>

        <div style={{
          height: '6px',
          backgroundColor: '#E0DFDC',
          borderRadius: '3px',
          overflow: 'hidden',
          marginTop: '8px',
        }}>
          <div style={{
            height: '100%',
            width: `${hoursUsedPercent}%`,
            backgroundColor: '#FF8303',
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }} />
        </div>
        {totalHours > 0 && (
          <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
            {formatHours(Math.max(0, totalHours - hoursRemaining))} of {formatHours(totalHours)} used
          </p>
        )}

        {lowHours && hoursRemaining > 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            Running low — contact support to purchase more hours.
          </p>
        )}
        {hoursRemaining === 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            No hours remaining. Contact support to continue.
          </p>
        )}

        {trainingEndDate && (
          <div style={{
            borderTop: '1px solid #f3f4f6',
            marginTop: '10px',
            paddingTop: '10px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '6px',
          }}>
            <Flag size={14} color="#9ca3af" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: '#6b7280' }}>
              Training ends {formatEndDate(trainingEndDate)}
            </span>
          </div>
        )}
      </div>

      {/* ── My Exercises ── */}
      <div className="shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', borderRadius: '12px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
          <Pencil size={14} color="#FF8303" style={{ flexShrink: 0 }} />
          <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>My Exercises</p>
        </div>

        <div style={{
          height: '6px',
          backgroundColor: '#E0DFDC',
          borderRadius: '3px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${exercisePercent}%`,
            backgroundColor: '#FF8303',
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }} />
        </div>

        <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
          {completedExercises} of {assignedExercises} completed
        </p>

        <Link
          href="/student/study"
          onMouseEnter={() => setExercisesHovered(true)}
          onMouseLeave={() => setExercisesHovered(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginTop: '10px',
            padding: '8px 12px',
            backgroundColor: exercisesHovered ? '#FFE4CC' : '#FFF0E0',
            color: '#FF8303',
            border: 'none',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: '600',
            textDecoration: 'none',
            transition: 'background-color 0.18s ease',
          }}
        >
          <BookOpen size={14} />
          Do My Exercises
        </Link>
      </div>

      {/* ── Streak ── */}
      {streakWeeks >= 2 && (
        <div className="shadow-sm" style={{
          borderRadius: '12px',
          padding: '12px 14px',
          background: 'linear-gradient(135deg, #FFB942, #FF8303)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <Trophy size={18} color="#ffffff" style={{ flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: '13px', fontWeight: '700', color: '#ffffff', margin: 0 }}>Keep it up!</p>
            <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.9)', margin: 0 }}>{streakWeeks}-week streak</p>
          </div>
        </div>
      )}

    </aside>
  )
}
