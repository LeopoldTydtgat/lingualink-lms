'use client'

import { useState, useEffect, useRef } from 'react'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: (records: AvailabilityRecord[]) => void
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const DAY_OF_WEEK_MAP: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 0,
}

// Generate slots in 30-minute increments from 00:00 to 23:30
const SLOTS = Array.from({ length: 48 }, (_, i) => ({
  hour: Math.floor(i / 2),
  minute: (i % 2) * 30,
}))

// Convert hour + minute to a TIME string for Supabase e.g. "06:30:00"
function toTimeString(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
}

// Get the end time for a 30-minute slot
function endTimeString(hour: number, minute: number): string {
  if (minute === 30) return toTimeString(hour + 1, 0)
  return toTimeString(hour, 30)
}

// Format a slot label for the left column e.g. "06:00" or "06:30"
function slotLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function isSlotActive(availability: AvailabilityRecord[], dayName: string, hour: number, minute: number): boolean {
  const dow = DAY_OF_WEEK_MAP[dayName]
  return availability.some(
    a =>
      a.day_of_week === dow &&
      a.start_time === toTimeString(hour, minute) &&
      a.end_time === endTimeString(hour, minute)
  )
}

export default function GeneralAvailability({ profile, availability, onAvailabilityChange }: Props) {
  const generalSlots = availability.filter(a => a.type === 'general')

  const isDragging = useRef(false)
  const dragMode = useRef<'on' | 'off'>('on')
  const draggedSlots = useRef<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [localGeneral, setLocalGeneral] = useState<AvailabilityRecord[]>(generalSlots)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (scrollRef.current) {
      const rows = scrollRef.current.querySelectorAll('tr')
      const targetRow = rows[8 * 2] // 08:00 = slot index 16
      if (targetRow) {
        scrollRef.current.scrollTop = (targetRow as HTMLElement).offsetTop - 40
      }
    }
  }, [])

  useEffect(() => {
    setLocalGeneral(availability.filter(a => a.type === 'general'))
  }, [availability])

  useEffect(() => {
    async function handleMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false

      const slots = Array.from(draggedSlots.current)
      draggedSlots.current = new Set()
      if (slots.length === 0) return

      const otherRecords = availability.filter(a => a.type !== 'general')

      if (dragMode.current === 'on') {
        const inserts = slots
          .filter(slotKey => {
            const [dayName, hourStr, minuteStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const minute = parseInt(minuteStr)
            const dow = DAY_OF_WEEK_MAP[dayName]
            return !generalSlots.some(
              a => a.day_of_week === dow &&
                a.start_time === toTimeString(hour, minute) &&
                a.end_time === endTimeString(hour, minute)
            )
          })
          .map(slotKey => {
            const [dayName, hourStr, minuteStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const minute = parseInt(minuteStr)
            return {
              teacher_id: profile.id,
              type: 'general' as const,
              day_of_week: DAY_OF_WEEK_MAP[dayName],
              start_time: toTimeString(hour, minute),
              end_time: endTimeString(hour, minute),
              is_available: true,
            }
          })

        if (inserts.length === 0) return

        const results = await Promise.all(
          inserts.map(record =>
            fetch('/api/teacher/availability', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(record),
            }).then(async r => {
              if (r.ok) return { ok: true, data: await r.json().catch(() => null) }
              const body = await r.json().catch(() => ({}))
              console.error('[GeneralAvailability] save failed:', body)
              return { ok: false, data: null }
            })
          )
        )
        const anyFailed = results.some(r => !r.ok)
        if (!anyFailed) {
          setSaveError('')
          const newRecords = results.map(r => r.data).filter(Boolean) as AvailabilityRecord[]
          const updatedGeneral = [
            ...generalSlots.filter(a => !a.id.startsWith('temp-')),
            ...newRecords,
          ]
          onAvailabilityChange([...otherRecords, ...updatedGeneral])
        } else {
          // One or more saves failed — revert optimistic UI back to last persisted state
          setSaveError('Failed to save. Please try again.')
          setLocalGeneral(generalSlots)
        }
      } else {
        const idsToDelete = slots
          .map(slotKey => {
            const [dayName, hourStr, minuteStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const minute = parseInt(minuteStr)
            const dow = DAY_OF_WEEK_MAP[dayName]
            return generalSlots.find(
              a => a.day_of_week === dow &&
                a.start_time === toTimeString(hour, minute) &&
                a.end_time === endTimeString(hour, minute)
            )?.id
          })
          .filter((id): id is string => !!id && !id.startsWith('temp-'))

        if (idsToDelete.length === 0) return

        const results = await Promise.all(
          idsToDelete.map(id =>
            fetch(`/api/teacher/availability/${id}`, { method: 'DELETE' }).then(async r => {
              if (r.ok || r.status === 404) return true
              const body = await r.json().catch(() => ({}))
              console.error('[GeneralAvailability] delete failed:', body)
              return false
            })
          )
        )
        if (results.every(Boolean)) {
          setSaveError('')
          const updatedGeneral = generalSlots.filter(a => !idsToDelete.includes(a.id))
          onAvailabilityChange([...otherRecords, ...updatedGeneral])
        } else {
          // One or more deletes failed — revert optimistic UI
          setSaveError('Failed to remove slot(s). Please try again.')
          setLocalGeneral(generalSlots)
        }
      }
    }

    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [availability])

  function handleSlotMouseDown(dayName: string, hour: number, minute: number) {
    const active = isSlotActive(localGeneral, dayName, hour, minute)
    isDragging.current = true
    dragMode.current = active ? 'off' : 'on'
    draggedSlots.current = new Set()
    setSaveError('')
    applySlotLocally(dayName, hour, minute)
  }

  function handleSlotMouseEnter(dayName: string, hour: number, minute: number) {
    if (!isDragging.current) return
    applySlotLocally(dayName, hour, minute)
  }

  function applySlotLocally(dayName: string, hour: number, minute: number) {
    const slotKey = `${dayName}-${hour}-${minute}`
    if (draggedSlots.current.has(slotKey)) return
    draggedSlots.current.add(slotKey)

    const dow = DAY_OF_WEEK_MAP[dayName]
    const startTime = toTimeString(hour, minute)
    const endTime = endTimeString(hour, minute)

    if (dragMode.current === 'on') {
      const alreadyActive = localGeneral.some(
        a => a.day_of_week === dow && a.start_time === startTime && a.end_time === endTime
      )
      if (!alreadyActive) {
        const tempRecord: AvailabilityRecord = {
          id: `temp-${slotKey}`,
          teacher_id: profile.id,
          type: 'general',
          day_of_week: dow,
          start_time: startTime,
          end_time: endTime,
          is_available: true,
          start_at: null,
          end_at: null,
        }
        setLocalGeneral(prev => [...prev, tempRecord])
      }
    } else {
      setLocalGeneral(prev =>
        prev.filter(
          a => !(a.day_of_week === dow && a.start_time === startTime && a.end_time === endTime)
        )
      )
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-800">General Availability</h2>
        <p className="text-sm text-gray-500 mt-1">
          Set your recurring weekly availability. These slots will appear on your Day to Day calendar.
          Click or click and drag to select multiple slots. Orange = available.
        </p>
      </div>

      {saveError && (
        <p style={{ fontSize: '13px', color: '#DC2626', marginBottom: '12px', padding: '8px 12px', backgroundColor: '#FEF2F2', borderRadius: '6px', border: '1px solid #FECACA' }}>
          {saveError}
        </p>
      )}

      <div ref={scrollRef} className="overflow-x-auto select-none thin-scroll" style={{ maxHeight: '600px', overflowY: 'auto', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #E5E7EB' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '64px', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#F6C5B8', boxShadow: 'inset 0 -3px 0 #A8533F', borderRight: '1px solid #D1D5DB' }} />
              {DAYS.map(day => (
                <th
                  key={day}
                  style={{ padding: '12px 4px', textAlign: 'center', fontSize: '13px', fontWeight: '600', color: '#5C1F0A', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#F6C5B8', borderRight: '1px solid #E5E7EB', boxShadow: 'inset 0 -3px 0 #A8533F' }}
                >
                  {day.slice(0, 3)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLOTS.map(({ hour, minute }) => (
              <tr key={`${hour}-${minute}`} style={{ borderTop: '1px solid #E5E7EB' }}>
                {/* Only show the label on the hour, not on the :30 row — keeps it clean */}
                <td style={{ padding: '1px 12px 1px 8px', textAlign: 'right', fontSize: '11px', color: '#4B5563', whiteSpace: 'nowrap', borderRight: '1px solid #D1D5DB', borderLeft: '1px solid #D1D5DB', backgroundColor: '#F6C5B8' }}>
                  {minute === 0 ? slotLabel(hour, minute) : <span style={{ fontSize: '9px', color: '#9CA3AF' }}>{slotLabel(hour, minute)}</span>}
                </td>
                {DAYS.map(day => {
                  const active = isSlotActive(localGeneral, day, hour, minute)
                  return (
                    <td key={day} style={{ padding: '1px 3px', borderRight: '1px solid #D1D5DB' }}>
                      <button
                        onMouseDown={() => handleSlotMouseDown(day, hour, minute)}
                        onMouseEnter={() => handleSlotMouseEnter(day, hour, minute)}
                        onDragStart={e => e.preventDefault()}
                        style={{
                          width: '100%',
                          height: '28px',
                          borderRadius: '4px',
                          border: active ? '1px solid #FF8303' : 'none',
                          backgroundColor: active ? '#FFF0DC' : 'transparent',
                          color: active ? '#CC6600' : '#9CA3AF',
                          fontSize: '10px',
                          cursor: 'pointer',
                          transition: 'background-color 0.1s ease',
                          userSelect: 'none',
                        }}
                      >
                        {active ? '✓' : ''}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '16px' }}>
        Changes save automatically when you release the mouse.
      </p>
    </div>
  )
}
