'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
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

// Generate slots in 30-minute increments from 06:00 to 22:30
// Each entry is { hour: 6, minute: 0 }, { hour: 6, minute: 30 }, etc.
const SLOTS = Array.from({ length: 34 }, (_, i) => ({
  hour: Math.floor(i / 2) + 6,
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
  const supabase = createClient()
  const generalSlots = availability.filter(a => a.type === 'general')

  const isDragging = useRef(false)
  const dragMode = useRef<'on' | 'off'>('on')
  const draggedSlots = useRef<Set<string>>(new Set())
  const [localGeneral, setLocalGeneral] = useState<AvailabilityRecord[]>(generalSlots)

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

        const { data, error } = await supabase
          .from('availability')
          .insert(inserts)
          .select()

        if (!error && data) {
          const updatedGeneral = [
            ...generalSlots.filter(a => !a.id.startsWith('temp-')),
            ...(data as AvailabilityRecord[]),
          ]
          onAvailabilityChange([...otherRecords, ...updatedGeneral])
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

        const { error } = await supabase
          .from('availability')
          .delete()
          .in('id', idsToDelete)

        if (!error) {
          const updatedGeneral = generalSlots.filter(a => !idsToDelete.includes(a.id))
          onAvailabilityChange([...otherRecords, ...updatedGeneral])
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

      <div className="overflow-x-auto select-none">
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'auto' }}>
          <thead>
            <tr>
              <th style={{ width: '64px' }} />
              {DAYS.map(day => (
                <th
                  key={day}
                  style={{ width: '96px', padding: '8px 4px', textAlign: 'center', fontSize: '13px', fontWeight: '600', color: '#374151' }}
                >
                  {day.slice(0, 3)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLOTS.map(({ hour, minute }) => (
              <tr key={`${hour}-${minute}`}>
                {/* Only show the label on the hour, not on the :30 row — keeps it clean */}
                <td style={{ padding: '1px 12px 1px 0', textAlign: 'right', fontSize: '11px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                  {minute === 0 ? slotLabel(hour, minute) : ''}
                </td>
                {DAYS.map(day => {
                  const active = isSlotActive(localGeneral, day, hour, minute)
                  return (
                    <td key={day} style={{ padding: '1px 3px' }}>
                      <button
                        onMouseDown={() => handleSlotMouseDown(day, hour, minute)}
                        onMouseEnter={() => handleSlotMouseEnter(day, hour, minute)}
                        onDragStart={e => e.preventDefault()}
                        style={{
                          width: '90px',
                          height: '20px', // shorter rows for 30-min increments
                          borderRadius: '4px',
                          border: active ? '1px solid #FF8303' : '1px solid #E5E7EB',
                          backgroundColor: active ? '#FF8303' : '#F3F4F6',
                          color: active ? '#ffffff' : '#9CA3AF',
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