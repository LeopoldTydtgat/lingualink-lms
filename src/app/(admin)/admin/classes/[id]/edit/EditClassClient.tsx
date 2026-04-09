'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface Teacher {
  id: string
  full_name: string
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
}

// Build YYYY-MM-DD and HH:MM from a scheduled_at ISO string
// without relying on toISOString() which shifts to UTC
function parseScheduledAt(isoString: string): { date: string; time: string } {
  const d = new Date(isoString)
  const year = d.getFullYear()
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return { date: `${year}-${month}-${day}`, time: `${hours}:${mins}` }
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

const DURATIONS = [30, 60, 90]

export default function EditClassClient({ lesson, teachers }: Props) {
  const router = useRouter()

  const original = parseScheduledAt(lesson.scheduled_at)

  const [teacherId, setTeacherId] = useState(lesson.teacher_id)
  const [date, setDate] = useState(original.date)
  const [time, setTime] = useState(original.time)
  const [duration, setDuration] = useState(lesson.duration_minutes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const timeSlots = generateTimeSlots()
  const today = new Date()
  const todayString = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`

  async function handleSave() {
    setSaving(true)
    setError('')

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
      setError(data.error ?? 'Failed to save. Please try again.')
      setSaving(false)
      return
    }

    router.push(`/admin/classes/${lesson.id}`)
  }

  return (
    <div style={{ padding: '32px', maxWidth: '600px' }}>

      <Link href={`/admin/classes/${lesson.id}`} style={{ fontSize: '14px', color: '#FF8303', textDecoration: 'none' }}>
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
            onChange={(e) => setTeacherId(e.target.value)}
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
          {teacherId !== lesson.teacher_id && (
            <p style={{ fontSize: '12px', color: '#92400E', marginTop: '6px' }}>
              ⚠️ Changing the teacher will reassign the class. The Teams meeting link will need to be updated manually once MS Graph API is connected.
            </p>
          )}
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
            onChange={(e) => setDate(e.target.value)}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '10px 12px', fontSize: '14px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Time */}
        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
            Time ({lesson.teacher?.timezone ?? '—'})
          </label>
          <select
            value={time}
            onChange={(e) => setTime(e.target.value)}
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
            {DURATIONS.map((mins) => (
              <button
                key={mins}
                onClick={() => setDuration(mins)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '8px',
                  border: duration === mins ? '2px solid #FF8303' : '1px solid #E5E7EB',
                  backgroundColor: duration === mins ? '#FFF7ED' : 'white',
                  cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                  color: duration === mins ? '#FF8303' : '#374151',
                }}
              >
                {mins} min
              </button>
            ))}
          </div>
          {duration !== lesson.duration_minutes && (
            <p style={{ fontSize: '12px', color: '#92400E', marginTop: '6px' }}>
              ⚠️ Changing duration will adjust the student&apos;s hours balance accordingly.
            </p>
          )}
        </div>

      </div>

      {error && (
        <p style={{ fontSize: '13px', color: '#B91C1C', marginTop: '12px' }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
        <Link href={`/admin/classes/${lesson.id}`}>
          <button style={{
            padding: '12px 24px', borderRadius: '8px', border: '1px solid #D1D5DB',
            backgroundColor: 'white', fontSize: '14px', cursor: 'pointer', color: '#374151',
          }}>
            Cancel
          </button>
        </Link>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '12px 28px', borderRadius: '8px', border: 'none',
            backgroundColor: saving ? '#E5E7EB' : '#FF8303',
            color: saving ? '#9CA3AF' : 'white',
            fontSize: '14px', fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
