'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { isToday, isTomorrow } from 'date-fns'
import { CalendarDays, Plus } from 'lucide-react'
import { teacherCancelLesson } from './actions'
import { isCancelledStatus } from '@/lib/billing/billability'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { Button } from '@/components/ui/button'
import { EmptyStateCalendar } from '@/components/EmptyStateCalendar'

type Student = {
  id: string
  full_name: string
  photo_url: string | null
}

type Class = {
  id: string
  training_id: string
  starts_at: string
  ends_at: string
  status: string
  teams_link: string | null
  lesson_notes: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  student: Student
}

type Profile = {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

type Props = {
  classes: Class[]
  profile: Profile
  profileCompleted: boolean
  bannerDismissed: boolean
  teacherTimezone: string
}

function formatTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    hour12: false,
  }).format(new Date(isoString))
}

function formatDate(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(isoString))
}

function getLocalDateKey(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(isoString))
}

function groupByDay(classes: Class[], timezone: string): Record<string, Class[]> {
  return classes.reduce((groups, cls) => {
    const day = getLocalDateKey(cls.starts_at, timezone)
    if (!groups[day]) groups[day] = []
    groups[day].push(cls)
    return groups
  }, {} as Record<string, Class[]>)
}

function formatDayHeading(isoString: string, timezone: string): string {
  const date = new Date(isoString)
  if (isToday(date)) return 'Today'
  if (isTomorrow(date)) return 'Tomorrow'
  return formatDate(isoString, timezone)
}

function Countdown({ startsAt }: { startsAt: string }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    function update() {
      const diff = new Date(startsAt).getTime() - Date.now()
      if (diff <= 0) {
        setTimeLeft('Starting now')
        return
      }
      const totalSeconds = Math.floor(diff / 1000)
      const days = Math.floor(totalSeconds / 86400)
      const hours = Math.floor((totalSeconds % 86400) / 3600)
      const minutes = Math.floor((totalSeconds % 3600) / 60)
      const seconds = totalSeconds % 60
      if (days > 0) {
        setTimeLeft(days + 'd ' + hours + 'h ' + String(minutes).padStart(2, '0') + 'm')
      } else {
        setTimeLeft(hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's')
      }
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [startsAt])

  return <span className="font-mono text-sm" style={{ color: '#FF8303' }}>{timeLeft}</span>
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: rotated ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
        color: '#9ca3af',
        flexShrink: 0
      }}
    >
      <path d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function ActionButton({ label, onClick }: { label: string; onClick?: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
      style={{
        border: hovered ? '2px solid #FF8303' : '2px solid #d1d5db',
        backgroundColor: 'white',
        color: hovered ? '#FF8303' : '#374151',
      }}
    >
      {label}
    </button>
  )
}

function ClassCard({ cls, onReschedule, teacherTimezone, mounted, nextId }: { cls: Class; onReschedule: (cls: Class) => void; teacherTimezone: string; mounted: boolean; nextId: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const minutesUntilStart = (new Date(cls.starts_at).getTime() - Date.now()) / 1000 / 60
  const isCancelled = isCancelledStatus(cls.status)
  const cancelLabel = getCancellationLabel(cls, 'teacher')
  const durationMin = Math.round((new Date(cls.ends_at).getTime() - new Date(cls.starts_at).getTime()) / 60000)
  const isNext = mounted && cls.id === nextId && !isCancelled
  const showReschedule = minutesUntilStart > 24 * 60 && !isCancelled

  return (
    <div
      className="rounded-xl bg-white shadow-sm overflow-hidden"
      style={{
        border: '1px solid #f3f4f6',
        borderLeft: isNext ? '3px solid #FF8303'
          : '1px solid #f3f4f6',
        opacity: isCancelled ? 0.75 : undefined,
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: '#FFE8C2' }}
        >
          {cls.student.photo_url ? (
            <img
              src={cls.student.photo_url}
              alt={cls.student.full_name}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <span className="font-semibold text-sm" style={{ color: '#FF8303' }}>
              {cls.student.full_name.charAt(0)}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <a
            href={`/students/${cls.training_id}`}
            onClick={e => e.stopPropagation()}
            style={{ color: 'inherit', textDecoration: 'none' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#FF8303')}
            onMouseLeave={e => (e.currentTarget.style.color = 'inherit')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <p className="font-semibold" style={isCancelled ? { textDecoration: 'line-through' } : undefined}>{cls.student.full_name}</p>
              {isNext && (
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', padding: '2px 8px', backgroundColor: '#FF8303', color: '#ffffff', borderRadius: '4px' }}>
                  NEXT
                </span>
              )}
            </div>
          </a>
          <p className="text-sm text-gray-500">
            {mounted
              ? isCancelled
                ? `${formatDate(cls.starts_at, teacherTimezone)} · ${formatTime(cls.starts_at, teacherTimezone)} - ${formatTime(cls.ends_at, teacherTimezone)} · ${durationMin} min`
                : `${formatTime(cls.starts_at, teacherTimezone)} - ${formatTime(cls.ends_at, teacherTimezone)} · ${durationMin} min`
              : ''}
          </p>
          {(cls.cancelled_by || cls.rescheduled_by) && cancelLabel && (
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
              {cancelLabel}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {isCancelled
            ? <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', backgroundColor: '#FFEEE6', color: '#FD5602', borderRadius: '4px' }}>Cancelled</span>
            : <Countdown startsAt={cls.starts_at} />}
          <ChevronIcon rotated={expanded} />
        </div>
      </button>

      {expanded && (
        <div className="p-4 space-y-4 bg-gray-50" style={{ borderTop: '1px solid #f3f4f6' }}>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Lesson Notes / To-do
            </p>
            <p className="text-sm text-gray-700">
              {cls.lesson_notes ?? 'No notes added yet.'}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {showReschedule && (
              <ActionButton label="Reschedule" onClick={() => onReschedule(cls)} />
            )}
            <ActionButton
              label={'Message ' + cls.student.full_name.split(' ')[0]}
              onClick={() => window.location.href = `/messages?studentId=${cls.student.id}`}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function DayGroup({ dateStr, classes, onReschedule, teacherTimezone, mounted, nextId }: { dateStr: string; classes: Class[]; onReschedule: (cls: Class) => void; teacherTimezone: string; mounted: boolean; nextId: string | null }) {
  const [open, setOpen] = useState(true)
  const heading = mounted ? formatDayHeading(classes[0].starts_at, teacherTimezone) : dateStr

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-left w-full"
      >
        <span className="font-semibold text-gray-800">{heading}</span>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', backgroundColor: '#f3f4f6', borderRadius: '9999px', padding: '2px 10px' }}>
          {classes.length} {classes.length === 1 ? 'lesson' : 'lessons'}
        </span>
        <div className="ml-auto">
          <ChevronIcon rotated={open} />
        </div>
      </button>

      {open && (
        <div className="space-y-2">
          {classes.map(cls => (
            <ClassCard key={cls.id} cls={cls} onReschedule={onReschedule} teacherTimezone={teacherTimezone} mounted={mounted} nextId={nextId} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function UpcomingClassesClient({ classes, profile, profileCompleted, bannerDismissed, teacherTimezone }: Props) {
  const router = useRouter()

  const [showProfileBanner, setShowProfileBanner] = useState(!profileCompleted && !bannerDismissed)
  const [mounted, setMounted] = useState(false)
  const [hideCancelled, setHideCancelled] = useState(false)
  const [cancelledSectionExpanded, setCancelledSectionExpanded] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      const stored = localStorage.getItem('lingualink_teacher_hide_cancelled')
      if (stored === 'true') setHideCancelled(true)
    } catch {}
    try {
      const stored = localStorage.getItem('lingualink_teacher_cancelled_section_expanded')
      if (stored === 'true') setCancelledSectionExpanded(true)
    } catch {}
  }, [])

  const scheduledCount = classes.filter(c => c.status === 'scheduled').length
  const upcomingClasses = classes.filter(c => !isCancelledStatus(c.status))
  const cancelledClasses = classes
    .filter(c => isCancelledStatus(c.status))
    .sort((a, b) => {
      const ta = a.cancelled_at ?? a.starts_at
      const tb = b.cancelled_at ?? b.starts_at
      return new Date(tb).getTime() - new Date(ta).getTime()
    })
  const grouped = groupByDay(upcomingClasses, teacherTimezone)
  const days = Object.keys(grouped).sort()
  const nextId = upcomingClasses.length > 0 ? upcomingClasses[0].id : null

  const [rescheduleTarget, setRescheduleTarget] = useState<Class | null>(null)
  const [rescheduleMessage, setRescheduleMessage] = useState('')
  const [rescheduleLoading, setRescheduleLoading] = useState(false)
  const [rescheduleError, setRescheduleError] = useState<string | null>(null)
  const [rescheduleSuccess, setRescheduleSuccess] = useState(false)

  function handleOpenReschedule(cls: Class) {
    setRescheduleTarget(cls)
    setRescheduleMessage('')
    setRescheduleError(null)
    setRescheduleSuccess(false)
  }

  function handleCloseReschedule() {
    if (rescheduleLoading) return
    router.refresh()
    setRescheduleTarget(null)
    setRescheduleMessage('')
    setRescheduleError(null)
    setRescheduleSuccess(false)
  }

  async function handleConfirmReschedule() {
    if (!rescheduleTarget) return
    if (!rescheduleMessage.trim()) {
      setRescheduleError('You must write a message to your student before rescheduling.')
      return
    }
    setRescheduleLoading(true)
    setRescheduleError(null)
    try {
      const result = await teacherCancelLesson(rescheduleTarget.id, rescheduleMessage.trim())
      if (!result.success) {
        setRescheduleError(result.error)
      } else {
        setRescheduleSuccess(true)
      }
    } catch {
      setRescheduleError('Something went wrong. Please try again.')
    } finally {
      setRescheduleLoading(false)
    }
  }

  function handleHideCancelledChange(checked: boolean) {
    setHideCancelled(checked)
    try {
      localStorage.setItem('lingualink_teacher_hide_cancelled', String(checked))
    } catch {}
  }

  function handleCancelledSectionToggle() {
    const next = !cancelledSectionExpanded
    setCancelledSectionExpanded(next)
    try { localStorage.setItem('lingualink_teacher_cancelled_section_expanded', String(next)) } catch {}
  }

  async function handleDismissBanner() {
    try {
      const res = await fetch('/api/profile/dismiss-banner', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Failed to persist banner dismiss:', data.error ?? res.status)
      }
    } catch (err) {
      console.error('Failed to persist banner dismiss:', err)
    }
    setShowProfileBanner(false)
  }

  return (
    <div className="space-y-6">

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
              href="/account"
              style={{ color: '#FF8303', fontWeight: 600, textDecoration: 'none' }}
            >
              Complete now →
            </a>
          </p>
          <button
            onClick={handleDismissBanner}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '0 4px', fontSize: '18px', lineHeight: 1, flexShrink: 0 }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Upcoming Classes</h1>
          <p className="text-sm text-gray-500 mt-1">
            {scheduledCount} {scheduledCount === 1 ? 'class' : 'classes'} scheduled
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {classes.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#6b7280', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={hideCancelled}
                onChange={(e) => handleHideCancelledChange(e.target.checked)}
                style={{ accentColor: '#FF8303' }}
              />
              Hide cancelled
            </label>
          )}
        </div>
      </div>

      {days.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col items-center text-center py-12 px-6">
          <EmptyStateCalendar />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">No upcoming classes yet</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-[380px]">
            Your booked classes will appear here. Keep your availability up to date so students can book you.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}>
              <Link href="/schedule" prefetch={false}>
                <CalendarDays />
                Update your availability
              </Link>
            </Button>
            {profile.role === 'admin' && (
              <Button asChild variant="outline">
                <Link href="/admin/classes/new" prefetch={false}>
                  <Plus />
                  Add a class
                </Link>
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {days.map(day => (
            <DayGroup key={day} dateStr={day} classes={grouped[day]} onReschedule={handleOpenReschedule} teacherTimezone={teacherTimezone} mounted={mounted} nextId={nextId} />
          ))}
        </div>
      )}

      {!hideCancelled && cancelledClasses.length > 0 && (
        <div className="space-y-3">
          <button
            onClick={handleCancelledSectionToggle}
            className="flex items-center gap-2 text-left w-full"
          >
            <span className="font-semibold text-gray-800">Cancelled</span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#FD5602', backgroundColor: '#FFEEE6', borderRadius: '9999px', padding: '2px 10px' }}>
              {cancelledClasses.length}
            </span>
            <div className="ml-auto">
              <ChevronIcon rotated={cancelledSectionExpanded} />
            </div>
          </button>

          {cancelledSectionExpanded && (
            <div className="space-y-2">
              {cancelledClasses.map(cls => (
                <ClassCard key={cls.id} cls={cls} onReschedule={handleOpenReschedule} teacherTimezone={teacherTimezone} mounted={mounted} nextId={null} />
              ))}
            </div>
          )}
        </div>
      )}

      {rescheduleTarget && (
        <div
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
          }}
          onClick={(e) => { if (e.target === e.currentTarget) handleCloseReschedule() }}
        >
          <div style={{
            backgroundColor: 'white', borderRadius: '12px', padding: '28px',
            width: '100%', maxWidth: '480px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)'
          }}>
            {rescheduleSuccess ? (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', marginBottom: '12px' }}>
                  Message sent
                </h2>
                <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px', lineHeight: 1.6 }}>
                  Your message has been sent to {rescheduleTarget.student.full_name} and the class has been cancelled.
                  They will need to book a new slot.
                </p>
                <button
                  onClick={handleCloseReschedule}
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px',
                    backgroundColor: '#FF8303', color: 'white',
                    fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', marginBottom: '4px' }}>
                  Cancel class & request reschedule
                </h2>
                <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
                  Class with {rescheduleTarget.student.full_name} - {mounted ? `${formatDate(rescheduleTarget.starts_at, teacherTimezone)}, ${formatTime(rescheduleTarget.starts_at, teacherTimezone)}` : ''}
                </p>
                <p style={{ fontSize: '14px', color: '#111827', marginBottom: '8px', fontWeight: 500 }}>
                  Message to student <span style={{ color: '#ef4444' }}>*</span>
                </p>
                <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '10px', lineHeight: 1.5 }}>
                  Write a message to your student explaining why. The class will be cancelled and they will book a new time themselves. This message is required.
                </p>
                <textarea
                  value={rescheduleMessage}
                  onChange={e => setRescheduleMessage(e.target.value)}
                  placeholder="Hi, I'm sorry but I need to reschedule our class on..."
                  rows={4}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
                    border: rescheduleError ? '2px solid #ef4444' : '2px solid #d1d5db',
                    outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box'
                  }}
                />
                {rescheduleError && (
                  <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '6px' }}>{rescheduleError}</p>
                )}
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button
                    onClick={handleCloseReschedule}
                    disabled={rescheduleLoading}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                      border: '2px solid #d1d5db', backgroundColor: 'white', cursor: 'pointer', color: '#374151'
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmReschedule}
                    disabled={rescheduleLoading}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 600,
                      backgroundColor: rescheduleLoading ? '#fbbf24' : '#FF8303',
                      color: 'white', border: 'none', cursor: rescheduleLoading ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {rescheduleLoading ? 'Sending...' : 'Send message & cancel class'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
