// src/components/student/layout/StudentRightPanel.tsx
// Help & Support section removed â€” the ChatWidget floating bubble replaces it.
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface NextLesson {
  scheduled_at: string
  teams_join_url: string | null
  duration_minutes: number
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

function isJoinable(isoString: string, now: number): boolean {
  const secondsUntil = Math.max(0, Math.floor((new Date(isoString).getTime() - now) / 1000))
  return secondsUntil <= 600 // 10 minutes
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: '8px',
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
      style={{
        width: '240px',
        minWidth: '240px',
        backgroundColor: '#ffffff',
        borderLeft: '1px solid #E0DFDC',
        padding: '20px 16px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        flexShrink: 0,
      }}
    >

      {/* â”€â”€ Next Class â”€â”€ */}
      <div>
        <p style={SECTION_LABEL}>Next Class</p>

        {nextLesson ? (
          <>
            <p style={{
              fontSize: '22px',
              fontWeight: '700',
              color: '#FF8303',
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
                  href={mounted && isJoinable(nextLesson.scheduled_at, now)
                    ? nextLesson.teams_join_url
                    : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block',
                    padding: '7px 12px',
                    backgroundColor: mounted && isJoinable(nextLesson.scheduled_at, now)
                      ? '#FF8303'
                      : '#E0DFDC',
                    color: mounted && isJoinable(nextLesson.scheduled_at, now)
                      ? '#ffffff'
                      : '#9ca3af',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '500',
                    textAlign: 'center',
                    textDecoration: 'none',
                    cursor: mounted && isJoinable(nextLesson.scheduled_at, now)
                      ? 'pointer'
                      : 'default',
                    pointerEvents: mounted && isJoinable(nextLesson.scheduled_at, now)
                      ? 'auto'
                      : 'none',
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
            <p style={{ fontSize: '22px', fontWeight: '700', color: '#FF8303' }}>--</p>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
              No upcoming classes
            </p>
          </>
        )}
      </div>

      {/* â”€â”€ Hours Remaining â”€â”€ */}
      <div>
        <p style={SECTION_LABEL}>Hours Remaining</p>

        <p style={{
          fontSize: '18px',
          fontWeight: '700',
          color: lowHours ? '#FD5602' : '#FF8303',
          marginBottom: '2px',
        }}>
          {formatHours(hoursRemaining)}
        </p>

        {lowHours && hoursRemaining > 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            Running low â€” contact admin to purchase more hours.
          </p>
        )}
        {hoursRemaining === 0 && (
          <p style={{ fontSize: '12px', color: '#FD5602', marginTop: '4px' }}>
            No hours remaining. Contact admin to continue.
          </p>
        )}
      </div>

      {/* â”€â”€ Training End Date â”€â”€ */}
      <div>
        <p style={SECTION_LABEL}>Training Ends</p>
        <p style={{ fontSize: '13px', color: '#6b7280' }}>
          {trainingEndDate ? formatEndDate(trainingEndDate) : '--'}
        </p>
      </div>

      {/* â”€â”€ Exercises Progress â”€â”€ */}
      <div>
        <p style={SECTION_LABEL}>My Exercises</p>

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
          style={{
            display: 'block',
            marginTop: '10px',
            padding: '7px 12px',
            backgroundColor: '#FF8303',
            color: '#ffffff',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '500',
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          Do My Exercises
        </Link>
      </div>

    </aside>
  )
}

