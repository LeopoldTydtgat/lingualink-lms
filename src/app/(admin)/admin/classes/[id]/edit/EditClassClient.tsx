'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

interface Teacher {
  id: string
  full_name: string
  timezone: string | null
}

interface LessonDetail {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  teacher_id: string
  student_id: string
  teacher: { id: string; full_name: string; timezone: string | null } | null
  student: { id: string; full_name: string } | null
}

interface Props {
  lesson: LessonDetail
  teachers: Teacher[]
  totalHours: number
  hoursConsumed: number
}

// Render the stored UTC instant as wall-clock parts in the teacher's timezone,
// so the form opens showing the time the teacher sees, not the admin browser's.
function parseScheduledAt(isoString: string, teacherTz: string): { date: string; time: string } {
  const d = new Date(isoString)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: teacherTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
  let hour = get('hour')
  if (hour === '24') hour = '00'
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${hour}:${get('minute')}`
  return { date, time }
}

function buildLocalISOString(year: number, month: number, day: number, hour: number, minute: number): string {
  const mm = month.toString().padStart(2, '0')
  const dd = day.toString().padStart(2, '0')
  const hh = hour.toString().padStart(2, '0')
  const mi = minute.toString().padStart(2, '0')
  return `${year}-${mm}-${dd}T${hh}:${mi}:00`
}

function generateTimeSlots(): string[] {
  const slots: string[] = []
  for (let h = 6; h <= 21; h++) {
    slots.push(`${h.toString().padStart(2, '0')}:00`)
    slots.push(`${h.toString().padStart(2, '0')}:30`)
  }
  slots.push('22:00')
  return slots
}

// Convert a UTC ISO slot start to "HH:MM" in the given IANA timezone
function slotLocalTime(startIso: string, timezone: string): string {
  const date = new Date(startIso)
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(date)
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`
}

const DURATIONS = [30, 60, 90]

export default function EditClassClient({ lesson, teachers, totalHours, hoursConsumed }: Props) {
  const router = useRouter()

  // Fail closed on a missing teacher timezone: never compute against a guessed
  // zone. The ternary keeps parseScheduledAt from ever running with a bad tz,
  // and the early return below (after all hooks) surfaces the data problem.
  const teacherTz = lesson.teacher?.timezone ?? null
  const original = teacherTz
    ? parseScheduledAt(lesson.scheduled_at, teacherTz)
    : { date: '', time: '' }

  const [teacherId, setTeacherId] = useState(lesson.teacher_id)
  const [date, setDate] = useState(original.date)
  const [time, setTime] = useState(original.time)
  const [duration, setDuration] = useState(lesson.duration_minutes)
  const [saving, setSaving] = useState(false)
  const [checkingAvailability, setCheckingAvailability] = useState(false)
  const [availabilityWarning, setAvailabilityWarning] = useState(false)

  const selectedTeacherTz =
    teachers.find((t) => t.id === teacherId)?.timezone
    ?? (teacherId === lesson.teacher_id ? lesson.teacher?.timezone : null)
    ?? null

  if (!selectedTeacherTz) {
    return (
      <div style={{ padding: '32px', maxWidth: '600px' }}>
        <Link href={`/admin/classes/${lesson.id}`} prefetch={false} style={{ fontSize: '14px', color: '#FF8303', textDecoration: 'none' }}>
          ← Back to Class Detail
        </Link>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: '20px 0 4px' }}>
          Edit Class
        </h1>
        <p style={{ fontSize: '14px', color: '#B91C1C', marginTop: '20px' }}>
          This class&apos;s teacher has no timezone set, so it cannot be safely edited.
          Set the teacher&apos;s timezone first, then return here.
        </p>
      </div>
    )
  }

  const timeSlots = generateTimeSlots()
  const today = new Date()
  const todayString = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`

  // The existing PATCH logic, unchanged. Called either directly (slot matched)
  // or from "Proceed anyway" (admin override).
  async function executeSave() {
    setSaving(true)

    const [year, month, day] = date.split('-').map(Number)
    const [hour, minute] = time.split(':').map(Number)
    const scheduledAt = buildLocalISOString(year, month, day, hour, minute)

    const payload: Record<string, unknown> = {
      action: 'edit',
      scheduled_at: scheduledAt,
      teacher_id: teacherId,
      duration_minutes: duration,
    }

    const res = await fetch(`/api/admin/classes/${lesson.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()

    if (!res.ok) {
      toast.error(data.error ?? 'Failed to save. Please try again.', { duration: 6000 })
      setSaving(false)
      return
    }

    setAvailabilityWarning(false)
    toast.success('Changes saved!')
    setTimeout(() => { router.push(`/admin/classes/${lesson.id}`) }, 800)
  }

  // Pre-flight: check teacher availability before saving. Fail-safe fallbacks:
  // if teacher was swapped (timezone unknown to the Teacher interface) or tz is
  // missing, warn by default so the admin consciously overrides rather than
  // silently bypassing.
  async function handleSave() {
    if (!selectedTeacherTz) {
      setAvailabilityWarning(true)
      return
    }
    setCheckingAvailability(true)
    setAvailabilityWarning(false)
    try {
      const res = await fetch(
        `/api/student/availability?teacherId=${teacherId}&weekStart=${date}&timezone=${encodeURIComponent(selectedTeacherTz)}`
      )
      if (res.ok) {
        const data = await res.json()
        const slotsForDate: { startIso: string; available: boolean }[] = data.slots?.[date] ?? []
        const match = slotsForDate.some(
          (slot) => slot.available && slotLocalTime(slot.startIso, selectedTeacherTz) === time
        )
        if (match) {
          await executeSave()
          return
        }
      }
      setAvailabilityWarning(true)
    } catch {
      setAvailabilityWarning(true)
    } finally {
      setCheckingAvailability(false)
    }
  }

  // Resolve selected teacher name for the warning text; falls back to the
  // original teacher in case the teachers list doesn't include the current id.
  const selectedTeacherName =
    teachers.find((t) => t.id === teacherId)?.full_name ?? lesson.teacher?.full_name ?? 'the teacher'

  return (
    <div style={{ padding: '32px', maxWidth: '600px' }}>

      <Link href={`/admin/classes/${lesson.id}`} prefetch={false} style={{ fontSize: '14px', color: '#FF8303', textDecoration: 'none' }}>
        ← Back to Class Detail
      </Link>

      <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: '20px 0 4px' }}>
        Edit Class
      </h1>
      <p style={{ fontSize: '14px', color: '#6B7280', marginBottom: '28px' }}>
        {lesson.student?.full_name} · Admin edits have no time restrictions.
      </p>

      <div style={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Teacher */}
        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
            Teacher
          </label>
          <select
            value={teacherId}
            onChange={(e) => { setTeacherId(e.target.value); setAvailabilityWarning(false) }}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '10px 12px', fontSize: '14px', outline: 'none',
              backgroundColor: 'white', boxSizing: 'border-box',
            }}
          >
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
            Date
          </label>
          <input
            type="date"
            min={todayString}
            value={date}
            onChange={(e) => { setDate(e.target.value); setAvailabilityWarning(false) }}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '10px 12px', fontSize: '14px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Time */}
        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
            Time ({selectedTeacherTz ?? '—'})
          </label>
          <select
            value={time}
            onChange={(e) => { setTime(e.target.value); setAvailabilityWarning(false) }}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '10px 12px', fontSize: '14px', outline: 'none',
              backgroundColor: 'white', boxSizing: 'border-box',
            }}
          >
            {timeSlots.map((slot) => (
              <option key={slot} value={slot}>{slot}</option>
            ))}
          </select>
        </div>

        {/* Duration */}
        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '8px' }}>
            Duration
          </label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {DURATIONS.map((mins) => {
              const delta = mins - lesson.duration_minutes
              const remainingHours = totalHours - hoursConsumed
              const isOriginal = mins === lesson.duration_minutes
              const insufficient = !isOriginal && delta > 0 && remainingHours < delta / 60
              return (
                <button
                  key={mins}
                  onClick={() => setDuration(mins)}
                  disabled={insufficient}
                  title={insufficient ? 'Insufficient hours - top up first' : undefined}
                  style={{
                    flex: 1, padding: '12px', borderRadius: '8px',
                    border: duration === mins ? '2px solid #FF8303' : '1px solid #E5E7EB',
                    backgroundColor: insufficient ? '#F3F4F6' : (duration === mins ? '#FFF7ED' : 'white'),
                    cursor: insufficient ? 'not-allowed' : 'pointer',
                    fontSize: '14px', fontWeight: 600,
                    color: insufficient ? '#9CA3AF' : (duration === mins ? '#FF8303' : '#374151'),
                    opacity: insufficient ? 0.6 : 1,
                  }}
                >
                  {mins} min
                </button>
              )
            })}
          </div>
          {duration !== lesson.duration_minutes && (
            <p style={{ fontSize: '12px', color: '#92400E', marginTop: '6px' }}>
              ⚠️ Lengthening deducts from the student&apos;s hours balance; shortening refunds. Buttons that exceed the remaining balance are disabled.
            </p>
          )}
        </div>

      </div>

      {/* Availability warning — shown when selected slot is outside teacher's set availability */}
      {availabilityWarning && (
        <div style={{
          backgroundColor: '#FFFBEB', border: '1px solid #FCD34D',
          borderRadius: '8px', padding: '14px 16px', marginTop: '16px',
        }}>
          <p style={{ fontSize: '13px', color: '#92400E', margin: '0 0 12px' }}>
            This time slot is outside <strong>{selectedTeacherName}&apos;s</strong> set availability.
            They have not indicated they are free at this time. Do you want to proceed anyway?
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => executeSave()}
              disabled={saving}
              style={{
                padding: '8px 16px', borderRadius: '6px', border: 'none',
                backgroundColor: '#F59E0B', color: 'white',
                fontSize: '13px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              Proceed anyway
            </button>
            <button
              onClick={() => setAvailabilityWarning(false)}
              style={{
                padding: '8px 16px', borderRadius: '6px', border: '1px solid #D1D5DB',
                backgroundColor: 'white', color: '#374151',
                fontSize: '13px', cursor: 'pointer',
              }}
            >
              Go back
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
        <Link href={`/admin/classes/${lesson.id}`} prefetch={false}>
          <button style={{
            padding: '12px 24px', borderRadius: '8px', border: '1px solid #D1D5DB',
            backgroundColor: 'white', fontSize: '14px', cursor: 'pointer', color: '#374151',
          }}>
            Cancel
          </button>
        </Link>
        {!availabilityWarning && (
          <button
            onClick={handleSave}
            disabled={saving || checkingAvailability}
            style={{
              padding: '12px 28px', borderRadius: '8px', border: 'none',
              backgroundColor: saving || checkingAvailability ? '#E5E7EB' : '#FF8303',
              color: saving || checkingAvailability ? '#9CA3AF' : 'white',
              fontSize: '14px', fontWeight: 600,
              cursor: saving || checkingAvailability ? 'not-allowed' : 'pointer',
            }}
          >
            {checkingAvailability ? 'Checking...' : saving ? 'Saving...' : 'Save Changes'}
          </button>
        )}
      </div>
    </div>
  )
}
