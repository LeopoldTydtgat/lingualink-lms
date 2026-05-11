// src/components/student/layout/StudentRightPanel.tsx
// Help & Support section removed — the ChatWidget floating bubble replaces it.
'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { BLOCKED_STATUSES } from '@/lib/billing/billability'

interface NextLesson {
  scheduled_at: string
  teams_join_url: string | null
  duration_minutes: number
  status: string
}

interface StudentRightPanelProps {
  studentId: string
  nextLesson: NextLesson | null
  hoursRemaining: number
  trainingEndDate: string | null
  assignedExercises: number
  completedExercises: number
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

function formatHours(hours: number): string {
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

function isJoinable(isoString: string, status: string, durationMinutes: number, now: number): boolean {
  if (BLOCKED_STATUSES.includes(status)) return false
  const startMs = new Date(isoString).getTime()
  const endMs = startMs + durationMinutes * 60 * 1000
  if (now > endMs) return false
  const secondsUntil = Math.max(0, Math.floor((startMs - now) / 1000))
  return secondsUntil <= 600 // 10 minutes
}


export default function StudentRightPanel({
  studentId: _studentId,
  nextLesson,
  hoursRemaining,
  trainingEndDate,
  assignedExercises,
  completedExercises,
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

  const exercisePercent = assignedExercises > 0
    ? Math.round((completedExercises / assignedExercises) * 100)
    : 0

  const lowHours = hoursRemaining < 2

  return (
    <aside
      ref={panelRef}
      onWheel={handleWheel}
      className="thin-scroll"
      style={{
        width: '240px',
        minWidth: '240px',
        backgroundColor: '#FFFCF8',
        borderLeft: '1px solid #E0DFDC',
        padding: '16px 12px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        flexShrink: 0,
      }}
    >

      {/* ── Next Class ── */}
      <div style={{ backgroundColor: '#ffffff', border: '0.5px solid #E0DFDC', borderRadius: '10px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '12px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Next Class</p>
        </div>

        {nextLesson ? (
          <>
            <p style={{
              fontSize: '22px',
              fontWeight: '700',
              color: '#111827',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: '1.2',
              marginBottom: '4px',
            }}>
              {mounted && secondsUntilNext !== null
                ? formatCountdown(secondsUntilNext)
                : '--:--:--'}
            </p>
            <p style={{ fontSize: '12px', color: '#9ca3af' }}>
              {nextLesson.duration_minutes} min class
            </p>

            <div style={{ marginTop: '10px' }}>
              {nextLesson.teams_join_url ? (
                <a
                  href={mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                    ? nextLesson.teams_join_url
                    : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onMouseEnter={() => setJoinHovered(true)}
                  onMouseLeave={() => setJoinHovered(false)}
                  style={{
                    display: 'block',
                    padding: '7px 12px',
                    backgroundColor: mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                      ? (joinHovered ? '#FF8303' : '#ffffff')
                      : '#E0DFDC',
                    color: mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                      ? (joinHovered ? '#ffffff' : '#FF8303')
                      : '#9ca3af',
                    border: mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                      ? '1.5px solid #FF8303'
                      : 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '600',
                    textAlign: 'center',
                    textDecoration: 'none',
                    cursor: mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                      ? 'pointer'
                      : 'default',
                    pointerEvents: mounted && isJoinable(nextLesson.scheduled_at, nextLesson.status, nextLesson.duration_minutes, now)
                      ? 'auto'
                      : 'none',
                    transition: 'background-color 0.18s ease, color 0.18s ease',
                  }}
                >
                  Join Class
                </a>
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

      {/* ── Hours Remaining ── */}
      <div style={{ backgroundColor: '#ffffff', border: '0.5px solid #E0DFDC', borderRadius: '10px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '12px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Hours Remaining</p>
        </div>

        <p style={{
          fontSize: '18px',
          fontWeight: '700',
          color: lowHours ? '#FD5602' : '#111827',
          marginBottom: '2px',
        }}>
          {formatHours(hoursRemaining)}
        </p>

        {lowHours && hoursRemaining > 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            Running low — contact admin to purchase more hours.
          </p>
        )}
        {hoursRemaining === 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            No hours remaining. Contact admin to continue.
          </p>
        )}
      </div>

      {/* ── Training End Date ── */}
      <div style={{ backgroundColor: '#ffffff', border: '0.5px solid #E0DFDC', borderRadius: '10px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '12px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Training Ends</p>
        </div>
        <p style={{ fontSize: '13px', color: '#6b7280' }}>
          {trainingEndDate ? formatEndDate(trainingEndDate) : '--'}
        </p>
      </div>

      {/* ── Exercises Progress ── */}
      <div style={{ backgroundColor: '#ffffff', border: '0.5px solid #E0DFDC', borderRadius: '10px', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '12px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>My Exercises</p>
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
            display: 'block',
            marginTop: '10px',
            padding: '7px 12px',
            backgroundColor: exercisesHovered ? '#FF8303' : '#ffffff',
            color: exercisesHovered ? '#ffffff' : '#FF8303',
            border: '1.5px solid #FF8303',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '600',
            textAlign: 'center',
            textDecoration: 'none',
            transition: 'background-color 0.18s ease, color 0.18s ease',
          }}
        >
          Do My Exercises
        </Link>
      </div>

    </aside>
  )
}
