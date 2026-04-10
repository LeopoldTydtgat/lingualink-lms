'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Video, X } from 'lucide-react'

interface UpcomingLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teams_join_url: string | null
  teacher_name: string
}

interface ClassReminderModalProps {
  studentId: string
}

const DISMISSED_KEY = 'lingualink_dismissed_reminders'
const CHECK_INTERVAL_MS = 60 * 1000  // check every 60 seconds
const REMINDER_WINDOW_S  = 15 * 60  // fire when class is within 15 minutes

function getDismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]')
  } catch {
    return []
  }
}

function addDismissed(lessonId: string) {
  try {
    const current = getDismissed()
    if (!current.includes(lessonId)) {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...current, lessonId]))
    }
  } catch {
    // sessionStorage unavailable — silently ignore
  }
}

// Manual time formatting — never use toLocaleTimeString() (hydration mismatch)
function formatTime(isoString: string): string {
  const d = new Date(isoString)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function formatDate(isoString: string): string {
  const d = new Date(isoString)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`
}

export default function ClassReminderModal({ studentId }: ClassReminderModalProps) {
  const [lesson, setLesson] = useState<UpcomingLesson | null>(null)
  const supabase = createClient()

  const checkForUpcoming = useCallback(async () => {
    const now = new Date()
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_S * 1000)

    const { data: rawLessons } = await supabase
      .from('lessons')
      .select(`
        id,
        scheduled_at,
        duration_minutes,
        teams_join_url,
        teacher:profiles!teacher_id (full_name)
      `)
      .eq('student_id', studentId)
      .eq('status', 'scheduled')
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', windowEnd.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)

    const row = rawLessons?.[0]
    if (!row) return

    // Flatten nested join — Supabase always returns arrays
    const teacher = Array.isArray(row.teacher) ? row.teacher[0] : row.teacher
    const teacherName: string = teacher?.full_name ?? 'Your teacher'

    // Don't re-show if already dismissed this session
    const dismissed = getDismissed()
    if (dismissed.includes(row.id)) return

    setLesson({
      id: row.id,
      scheduled_at: row.scheduled_at,
      duration_minutes: row.duration_minutes,
      teams_join_url: row.teams_join_url,
      teacher_name: teacherName,
    })
  }, [studentId, supabase])

  useEffect(() => {
    checkForUpcoming()
    const interval = setInterval(checkForUpcoming, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [checkForUpcoming])

  function handleDismiss() {
    if (lesson) addDismissed(lesson.id)
    setLesson(null)
  }

  if (!lesson) return null

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.45)',
          zIndex: 999,
        }}
        onClick={handleDismiss}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Class starting soon"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1000,
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '32px',
          width: '100%',
          maxWidth: '420px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
      >
        {/* Close button */}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss reminder"
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#9ca3af',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={20} />
        </button>

        {/* Orange accent bar */}
        <div
          style={{
            width: '48px',
            height: '4px',
            backgroundColor: '#FF8303',
            borderRadius: '2px',
            marginBottom: '20px',
          }}
        />

        {/* Heading */}
        <h2
          style={{
            fontSize: '20px',
            fontWeight: '700',
            color: '#111827',
            marginBottom: '4px',
          }}
        >
          {"It's time for your class!"}
        </h2>
        <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
          Your class is starting soon
        </p>

        {/* Class details card */}
        <div
          style={{
            backgroundColor: '#f9fafb',
            border: '1px solid #E0DFDC',
            borderRadius: '10px',
            padding: '16px',
            marginBottom: '24px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>Teacher</span>
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                {lesson.teacher_name}
              </span>
            </div>
            <div style={{ height: '1px', backgroundColor: '#E0DFDC' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>Date</span>
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                {formatDate(lesson.scheduled_at)}
              </span>
            </div>
            <div style={{ height: '1px', backgroundColor: '#E0DFDC' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>Time</span>
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                {formatTime(lesson.scheduled_at)}
              </span>
            </div>
            <div style={{ height: '1px', backgroundColor: '#E0DFDC' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>Duration</span>
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                {lesson.duration_minutes} minutes
              </span>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {lesson.teams_join_url ? (
            <a
              href={lesson.teams_join_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '12px',
                backgroundColor: '#FF8303',
                color: '#ffffff',
                borderRadius: '8px',
                fontSize: '15px',
                fontWeight: '600',
                textDecoration: 'none',
              }}
            >
              <Video size={18} />
              Join Class Now
            </a>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px',
                backgroundColor: '#f3f4f6',
                color: '#9ca3af',
                borderRadius: '8px',
                fontSize: '14px',
              }}
            >
              Teams link not yet available
            </div>
          )}

          <button
            onClick={handleDismiss}
            style={{
              padding: '10px',
              background: 'none',
              border: '1px solid #E0DFDC',
              borderRadius: '8px',
              fontSize: '14px',
              color: '#6b7280',
              cursor: 'pointer',
              fontWeight: '500',
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </>
  )
}
