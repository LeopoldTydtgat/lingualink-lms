'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { User, ChevronLeft, ChevronRight, Check } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Teacher {
  id: string
  full_name: string
  photo_url: string | null
  bio: string | null
  timezone: string | null
}

interface RescheduleLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teacher_id: string
}

interface Props {
  studentId: string
  studentTimezone: string
  trainingId: string
  hoursRemaining: number
  teachers: Teacher[]
  rescheduleLesson: RescheduleLesson | null
}

// A single 30-minute bookable slot
interface Slot {
  startIso: string  // UTC ISO string
  available: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatHours(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

// Get the Monday of the week containing a given date
function getWeekStart(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day // adjust to Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// Format a date as "Mon 7 Apr" in the student's timezone
function formatDayLabel(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(date)
}

// Format time as "09:00" in a given timezone
function formatSlotTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(isoString))
}

// Format full date+time for confirmation screen
function formatConfirmDateTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(isoString))
}

// Build YYYY-MM-DD from a Date in a given timezone — avoids toISOString() local date issues
function getLocalDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(date)
}

// Get day-of-week (0=Sun, 1=Mon ... 6=Sat) for a date in a given timezone
function getDayOfWeek(date: Date, timezone: string): number {
  const dayStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: timezone,
  }).format(date)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[dayStr] ?? 0
}

// ─── Step indicators ──────────────────────────────────────────────────────────

function StepIndicator({
  currentStep,
  totalSteps,
}: {
  currentStep: number
  totalSteps: number
}) {
  const labels =
    totalSteps === 4
      ? ['Teacher', 'Duration', 'Date & Time', 'Confirm']
      : ['Duration', 'Date & Time', 'Confirm']

  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '32px' }}>
      {labels.map((label, i) => {
        const stepNum = i + 1
        const isComplete = stepNum < currentStep
        const isActive = stepNum === currentStep

        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < labels.length - 1 ? 1 : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: '700',
                  backgroundColor: isComplete ? '#FF8303' : isActive ? '#FF8303' : '#E0DFDC',
                  color: isComplete || isActive ? '#ffffff' : '#9ca3af',
                }}
              >
                {isComplete ? <Check size={14} /> : stepNum}
              </div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: isActive ? '600' : '400',
                  color: isActive ? '#111827' : '#9ca3af',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: '2px',
                  backgroundColor: isComplete ? '#FF8303' : '#E0DFDC',
                  margin: '0 8px',
                  marginBottom: '20px',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1 — Teacher selection ───────────────────────────────────────────────

function StepTeacher({
  teachers,
  selectedTeacherId,
  onSelect,
}: {
  teachers: Teacher[]
  selectedTeacherId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Select your teacher
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Choose which teacher you would like to book with.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {teachers.map((teacher) => {
          const isSelected = selectedTeacherId === teacher.id
          return (
            <button
              key={teacher.id}
              onClick={() => onSelect(teacher.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                padding: '16px',
                borderRadius: '10px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                backgroundColor: isSelected ? '#fff7ed' : '#ffffff',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {teacher.photo_url ? (
                <Image
                  src={teacher.photo_url}
                  alt={teacher.full_name}
                  width={48}
                  height={48}
                  style={{ borderRadius: '50%', flexShrink: 0 }}
                />
              ) : (
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    backgroundColor: '#f3f4f6',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <User size={22} color="#9ca3af" />
                </div>
              )}
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
                  {teacher.full_name}
                </p>
                {teacher.bio && (
                  <p style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.5' }}>
                    {teacher.bio.length > 120 ? teacher.bio.slice(0, 120) + '…' : teacher.bio}
                  </p>
                )}
              </div>
              {isSelected && (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: '#FF8303',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Check size={14} color="#ffffff" />
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Step 2 — Duration selection ─────────────────────────────────────────────

function StepDuration({
  hoursRemaining,
  selectedDuration,
  onSelect,
}: {
  hoursRemaining: number
  selectedDuration: number | null
  onSelect: (minutes: number) => void
}) {
  const options = [
    { minutes: 30, label: '30 minutes', hours: 0.5 },
    { minutes: 60, label: '1 hour', hours: 1 },
    { minutes: 90, label: '1.5 hours', hours: 1.5 },
  ]

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Choose duration
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        You have <strong>{formatHours(hoursRemaining)}</strong> remaining in your training.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {options.map((option) => {
          const canBook = hoursRemaining >= option.hours
          const isSelected = selectedDuration === option.minutes

          return (
            <button
              key={option.minutes}
              onClick={() => canBook && onSelect(option.minutes)}
              disabled={!canBook}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 20px',
                borderRadius: '10px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : canBook ? '#E0DFDC' : '#f3f4f6',
                backgroundColor: isSelected ? '#fff7ed' : canBook ? '#ffffff' : '#fafafa',
                cursor: canBook ? 'pointer' : 'not-allowed',
                opacity: canBook ? 1 : 0.5,
              }}
            >
              <div>
                <p
                  style={{
                    fontSize: '15px',
                    fontWeight: '600',
                    color: canBook ? '#111827' : '#9ca3af',
                    marginBottom: '2px',
                  }}
                >
                  {option.label}
                </p>
                <p style={{ fontSize: '13px', color: '#9ca3af' }}>
                  Uses {formatHours(option.hours)} from your balance
                </p>
              </div>
              {!canBook && (
                <span
                  style={{
                    fontSize: '12px',
                    color: '#dc2626',
                    fontWeight: '500',
                  }}
                >
                  Not enough hours
                </span>
              )}
              {isSelected && canBook && (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: '#FF8303',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Check size={14} color="#ffffff" />
                </div>
              )}
            </button>
          )
        })}
      </div>

      {hoursRemaining < 0.5 && (
        <div
          style={{
            marginTop: '20px',
            padding: '14px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
          }}
        >
          <p style={{ fontSize: '13px', color: '#dc2626' }}>
            You do not have enough hours remaining to book a class. Please contact admin to purchase more hours.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Step 3 — Date and time selection ────────────────────────────────────────

function StepDateTime({
  teacherId,
  studentTimezone,
  durationMinutes,
  onSelect,
  selectedStartIso,
}: {
  teacherId: string
  studentTimezone: string
  durationMinutes: number
  onSelect: (isoString: string) => void
  selectedStartIso: string | null
}) {
  const slotsNeeded = durationMinutes / 30

  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [slots, setSlots] = useState<Record<string, Slot[]>>({}) // keyed by YYYY-MM-DD
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch availability slots from the API whenever week or teacher changes
  useEffect(() => {
    setLoading(true)
    setError(null)

    const weekStartStr = getLocalDateKey(weekStart, 'UTC')

    fetch(
      `/api/student/availability?teacherId=${teacherId}&weekStart=${weekStartStr}&timezone=${encodeURIComponent(studentTimezone)}`
    )
      .then((r) => r.json())
      .then((data) => {
        setSlots(data.slots ?? {})
        setLoading(false)
      })
      .catch(() => {
        setError('Could not load availability. Please try again.')
        setLoading(false)
      })
  }, [teacherId, weekStart, studentTimezone])

  // Build the 7 days of this week to display
  const weekDays: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    weekDays.push(d)
  }

  // Check if a slot at index `slotIndex` within a day can be the start of a booking
  // For 60 min: this slot AND the next must both be available
  // For 90 min: this slot AND the next two must all be available
  function isBookableStart(daySlots: Slot[], slotIndex: number): boolean {
    for (let i = 0; i < slotsNeeded; i++) {
      const s = daySlots[slotIndex + i]
      if (!s || !s.available) return false
    }
    return true
  }

  const goBack = () => {
    const prev = new Date(weekStart)
    prev.setDate(prev.getDate() - 7)
    // Don't allow going before current week
    if (prev >= getWeekStart(new Date())) setWeekStart(prev)
    else setWeekStart(getWeekStart(new Date()))
  }

  const goForward = () => {
    const next = new Date(weekStart)
    next.setDate(next.getDate() + 7)
    setWeekStart(next)
  }

  const isPrevDisabled = weekStart <= getWeekStart(new Date())

  // Week label e.g. "31 Mar – 6 Apr 2026"
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const weekLabel = `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(weekStart)} – ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(weekEnd)}`

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Choose date and time
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Times shown in your local timezone ({studentTimezone}).
      </p>

      {/* Week navigation */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
        }}
      >
        <button
          onClick={goBack}
          disabled={isPrevDisabled}
          style={{
            padding: '6px 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '6px',
            backgroundColor: '#ffffff',
            cursor: isPrevDisabled ? 'not-allowed' : 'pointer',
            opacity: isPrevDisabled ? 0.4 : 1,
          }}
        >
          <ChevronLeft size={16} color="#4b5563" />
        </button>
        <span style={{ fontSize: '14px', fontWeight: '600', color: '#111827' }}>
          {weekLabel}
        </span>
        <button
          onClick={goForward}
          style={{
            padding: '6px 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '6px',
            backgroundColor: '#ffffff',
            cursor: 'pointer',
          }}
        >
          <ChevronRight size={16} color="#4b5563" />
        </button>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '14px' }}>
          Loading availability...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '14px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            fontSize: '13px',
            color: '#dc2626',
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
          {weekDays.map((day) => {
            const dateKey = getLocalDateKey(day, studentTimezone)
            const daySlots = slots[dateKey] ?? []
            const isPast = day < new Date(new Date().setHours(0, 0, 0, 0))

            return (
              <div key={dateKey}>
                {/* Day header */}
                <div
                  style={{
                    textAlign: 'center',
                    marginBottom: '6px',
                    padding: '6px 4px',
                    borderRadius: '6px',
                    backgroundColor: isPast ? '#f9fafb' : '#f3f4f6',
                  }}
                >
                  <p
                    style={{
                      fontSize: '11px',
                      fontWeight: '600',
                      color: isPast ? '#d1d5db' : '#374151',
                      textTransform: 'uppercase',
                    }}
                  >
                    {formatDayLabel(day, studentTimezone).split(' ')[0]}
                  </p>
                  <p style={{ fontSize: '13px', fontWeight: '700', color: isPast ? '#d1d5db' : '#111827' }}>
                    {day.getDate()}
                  </p>
                </div>

                {/* Slots */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {daySlots.length === 0 && !isPast && (
                    <div
                      style={{
                        height: '32px',
                        borderRadius: '4px',
                        backgroundColor: '#f9fafb',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <span style={{ fontSize: '10px', color: '#d1d5db' }}>—</span>
                    </div>
                  )}
                  {daySlots.map((slot, i) => {
                    const canBook = !isPast && isBookableStart(daySlots, i)
                    const isSelected = selectedStartIso === slot.startIso

                    // Don't render unavailable slots that also can't be booked
                    if (!slot.available && !canBook) return null

                    return (
                      <button
                        key={slot.startIso}
                        onClick={() => canBook && onSelect(slot.startIso)}
                        disabled={!canBook}
                        style={{
                          padding: '5px 2px',
                          borderRadius: '4px',
                          border: '1px solid',
                          borderColor: isSelected ? '#FF8303' : canBook ? '#E0DFDC' : 'transparent',
                          backgroundColor: isSelected
                            ? '#FF8303'
                            : canBook
                            ? '#fff7ed'
                            : '#f3f4f6',
                          color: isSelected ? '#ffffff' : canBook ? '#FF8303' : '#d1d5db',
                          fontSize: '11px',
                          fontWeight: '600',
                          cursor: canBook ? 'pointer' : 'default',
                          textAlign: 'center',
                          width: '100%',
                        }}
                      >
                        {formatSlotTime(slot.startIso, studentTimezone)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: '#fff7ed', border: '1px solid #E0DFDC' }} />
          <span style={{ fontSize: '12px', color: '#6b7280' }}>Available</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: '#FF8303' }} />
          <span style={{ fontSize: '12px', color: '#6b7280' }}>Selected</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: '#f3f4f6' }} />
          <span style={{ fontSize: '12px', color: '#6b7280' }}>Unavailable</span>
        </div>
      </div>
    </div>
  )
}

// ─── Step 4 — Confirm ─────────────────────────────────────────────────────────

function StepConfirm({
  teacher,
  durationMinutes,
  startIso,
  studentTimezone,
  hoursRemaining,
  isSubmitting,
  onConfirm,
}: {
  teacher: Teacher
  durationMinutes: number
  startIso: string
  studentTimezone: string
  hoursRemaining: number
  isSubmitting: boolean
  onConfirm: () => void
}) {
  const hoursUsed = durationMinutes / 60
  const hoursAfter = hoursRemaining - hoursUsed

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Confirm your booking
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Please review your class details before confirming.
      </p>

      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          overflow: 'hidden',
          marginBottom: '24px',
        }}
      >
        {/* Orange header */}
        <div style={{ backgroundColor: '#FF8303', padding: '12px 20px' }}>
          <span style={{ color: '#ffffff', fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Class Summary
          </span>
        </div>

        <div style={{ padding: '20px' }}>
          {/* Teacher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            {teacher.photo_url ? (
              <Image
                src={teacher.photo_url}
                alt={teacher.full_name}
                width={44}
                height={44}
                style={{ borderRadius: '50%' }}
              />
            ) : (
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <User size={20} color="#9ca3af" />
              </div>
            )}
            <div>
              <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827' }}>{teacher.full_name}</p>
              <p style={{ fontSize: '13px', color: '#9ca3af' }}>Your teacher</p>
            </div>
          </div>

          {/* Details rows */}
          {[
            { label: 'Date & Time', value: formatConfirmDateTime(startIso, studentTimezone) },
            { label: 'Duration', value: formatHours(durationMinutes / 60) },
            { label: 'Hours deducted', value: formatHours(hoursUsed) },
            { label: 'Remaining after booking', value: formatHours(hoursAfter) },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: '12px',
                paddingBottom: '12px',
                borderTop: '1px solid #f3f4f6',
              }}
            >
              <span style={{ fontSize: '14px', color: '#6b7280' }}>{label}</span>
              <span style={{ fontSize: '14px', fontWeight: '600', color: '#111827' }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {hoursAfter < 2 && hoursAfter >= 0 && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: '8px',
            fontSize: '13px',
            color: '#92400e',
            marginBottom: '20px',
          }}
        >
          After this booking you will have less than 2 hours remaining. Contact admin to purchase more hours.
        </div>
      )}

      <button
        onClick={onConfirm}
        disabled={isSubmitting}
        style={{
          width: '100%',
          padding: '14px',
          backgroundColor: isSubmitting ? '#9ca3af' : '#FF8303',
          color: '#ffffff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '15px',
          fontWeight: '700',
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
        }}
      >
        {isSubmitting ? 'Booking...' : 'Confirm Booking'}
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BookingClient({
  studentId,
  studentTimezone,
  trainingId,
  hoursRemaining,
  teachers,
  rescheduleLesson,
}: Props) {
  const router = useRouter()

  // If only one teacher, skip teacher selection step — steps are 3 not 4
  const skipTeacherStep = teachers.length === 1
  const totalSteps = skipTeacherStep ? 3 : 4

  // Step numbering: if skipping teacher step, step 1=Duration, 2=DateTime, 3=Confirm
  // If not skipping: step 1=Teacher, 2=Duration, 3=DateTime, 4=Confirm
  const [step, setStep] = useState(1)

  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(
    skipTeacherStep ? teachers[0].id : rescheduleLesson?.teacher_id ?? null
  )
  const [selectedDuration, setSelectedDuration] = useState<number | null>(
    rescheduleLesson?.duration_minutes ?? null
  )
  const [selectedStartIso, setSelectedStartIso] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const selectedTeacher = teachers.find((t) => t.id === selectedTeacherId) ?? null

  // Determine which logical step we're on regardless of skip
  // logicalStep: 'teacher' | 'duration' | 'datetime' | 'confirm'
  function getLogicalStep(): 'teacher' | 'duration' | 'datetime' | 'confirm' {
    if (!skipTeacherStep) {
      if (step === 1) return 'teacher'
      if (step === 2) return 'duration'
      if (step === 3) return 'datetime'
      return 'confirm'
    } else {
      if (step === 1) return 'duration'
      if (step === 2) return 'datetime'
      return 'confirm'
    }
  }

  const logicalStep = getLogicalStep()

  function handleNext() {
    setStep((s) => s + 1)
  }

  function handleBack() {
    if (step === 1) {
      router.push('/student/my-classes')
    } else {
      setStep((s) => s - 1)
    }
  }

  async function handleConfirm() {
    if (!selectedTeacherId || !selectedDuration || !selectedStartIso) return
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const res = await fetch('/api/student/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trainingId,
          teacherId: selectedTeacherId,
          studentId,
          durationMinutes: selectedDuration,
          scheduledAt: selectedStartIso,
          rescheduleId: rescheduleLesson?.id ?? null,
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        setSubmitError(data.error ?? 'Something went wrong. Please try again.')
        setIsSubmitting(false)
        return
      }

      // Success — go back to my classes
      router.push('/student/my-classes')
      router.refresh()
    } catch {
      setSubmitError('Something went wrong. Please try again.')
      setIsSubmitting(false)
    }
  }

  // Can the user proceed to the next step?
  function canProceed(): boolean {
    if (logicalStep === 'teacher') return selectedTeacherId !== null
    if (logicalStep === 'duration') return selectedDuration !== null
    if (logicalStep === 'datetime') return selectedStartIso !== null
    return true
  }

  return (
    <div style={{ maxWidth: '680px' }}>
      {/* Page header */}
      <div style={{ marginBottom: '8px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827' }}>
          {rescheduleLesson ? 'Reschedule Class' : 'Book a Class'}
        </h1>
      </div>

      {/* Step indicator */}
      <StepIndicator currentStep={step} totalSteps={totalSteps} />

      {/* Step content */}
      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          padding: '28px',
          marginBottom: '20px',
        }}
      >
        {logicalStep === 'teacher' && (
          <StepTeacher
            teachers={teachers}
            selectedTeacherId={selectedTeacherId}
            onSelect={(id) => {
              setSelectedTeacherId(id)
              setSelectedStartIso(null) // reset time if teacher changes
            }}
          />
        )}

        {logicalStep === 'duration' && (
          <StepDuration
            hoursRemaining={hoursRemaining}
            selectedDuration={selectedDuration}
            onSelect={(minutes) => {
              setSelectedDuration(minutes)
              setSelectedStartIso(null) // reset time if duration changes
            }}
          />
        )}

        {logicalStep === 'datetime' && selectedTeacherId && selectedDuration && (
          <StepDateTime
            teacherId={selectedTeacherId}
            studentTimezone={studentTimezone}
            durationMinutes={selectedDuration}
            selectedStartIso={selectedStartIso}
            onSelect={setSelectedStartIso}
          />
        )}

        {logicalStep === 'confirm' &&
          selectedTeacher &&
          selectedDuration &&
          selectedStartIso && (
            <StepConfirm
              teacher={selectedTeacher}
              durationMinutes={selectedDuration}
              startIso={selectedStartIso}
              studentTimezone={studentTimezone}
              hoursRemaining={hoursRemaining}
              isSubmitting={isSubmitting}
              onConfirm={handleConfirm}
            />
          )}

        {submitError && (
          <div
            style={{
              marginTop: '16px',
              padding: '12px 16px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              fontSize: '13px',
              color: '#dc2626',
            }}
          >
            {submitError}
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      {logicalStep !== 'confirm' && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button
            onClick={handleBack}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 18px',
              backgroundColor: '#ffffff',
              border: '1px solid #E0DFDC',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '500',
              color: '#4b5563',
              cursor: 'pointer',
            }}
          >
            <ChevronLeft size={16} />
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={!canProceed()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 18px',
              backgroundColor: canProceed() ? '#FF8303' : '#E0DFDC',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              color: canProceed() ? '#ffffff' : '#9ca3af',
              cursor: canProceed() ? 'pointer' : 'not-allowed',
            }}
          >
            Continue
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Back button on confirm step */}
      {logicalStep === 'confirm' && (
        <button
          onClick={handleBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 18px',
            backgroundColor: '#ffffff',
            border: '1px solid #E0DFDC',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: '500',
            color: '#4b5563',
            cursor: 'pointer',
          }}
        >
          <ChevronLeft size={16} />
          Back
        </button>
      )}
    </div>
  )
}
