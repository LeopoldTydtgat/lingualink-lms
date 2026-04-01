'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]        // FULL list from parent
  onAvailabilityChange: (records: AvailabilityRecord[]) => void
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const DAY_OF_WEEK_MAP: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 0,
}

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6)

function toTimeString(hour: number) {
  return `${String(hour).padStart(2, '0')}:00:00`
}

function isSlotActive(generalSlots: AvailabilityRecord[], dayName: string, hour: number): boolean {
  const dow = DAY_OF_WEEK_MAP[dayName]
  return generalSlots.some(
    a =>
      a.day_of_week === dow &&
      a.start_time === toTimeString(hour) &&
      a.end_time === toTimeString(hour + 1)
  )
}

export default function GeneralAvailability({ profile, availability, onAvailabilityChange }: Props) {
  const supabase = createClient()

  // Filter down to just general slots for display — but we always merge
  // back into the full list when saving so other tabs' data is preserved
  const generalSlots = availability.filter(a => a.type === 'general')

  const isDragging = useRef(false)
  const dragMode = useRef<'on' | 'off'>('on')
  const draggedSlots = useRef<Set<string>>(new Set())

  // Local visual state for instant feedback during drag
  const [localGeneral, setLocalGeneral] = useState<AvailabilityRecord[]>(generalSlots)

  // Keep local state in sync when parent availability changes
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

      // Get the non-general records so we can merge them back in after saving
      const otherRecords = availability.filter(a => a.type !== 'general')

      if (dragMode.current === 'on') {
        const inserts = slots
          .filter(slotKey => {
            // Don't insert slots that already exist in Supabase (only temp ones)
            const [dayName, hourStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const dow = DAY_OF_WEEK_MAP[dayName]
            return !generalSlots.some(
              a => a.day_of_week === dow &&
                a.start_time === toTimeString(hour) &&
                a.end_time === toTimeString(hour + 1)
            )
          })
          .map(slotKey => {
            const [dayName, hourStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            return {
              teacher_id: profile.id,
              type: 'general' as const,
              day_of_week: DAY_OF_WEEK_MAP[dayName],
              start_time: toTimeString(hour),
              end_time: toTimeString(hour + 1),
              is_available: true,
            }
          })

        if (inserts.length === 0) return

        const { data, error } = await supabase
          .from('availability')
          .insert(inserts)
          .select()

        if (!error && data) {
          // Merge: keep all non-general records + existing general records + new ones
          const updatedGeneral = [
            ...generalSlots.filter(a => !a.id.startsWith('temp-')),
            ...(data as AvailabilityRecord[]),
          ]
          onAvailabilityChange([...otherRecords, ...updatedGeneral])
        }
      } else {
        // Delete deactivated slots
        const idsToDelete = slots
          .map(slotKey => {
            const [dayName, hourStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const dow = DAY_OF_WEEK_MAP[dayName]
            return generalSlots.find(
              a => a.day_of_week === dow &&
                a.start_time === toTimeString(hour) &&
                a.end_time === toTimeString(hour + 1)
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

  function handleSlotMouseDown(dayName: string, hour: number) {
    const active = isSlotActive(localGeneral, dayName, hour)
    isDragging.current = true
    dragMode.current = active ? 'off' : 'on'
    draggedSlots.current = new Set()
    applySlotLocally(dayName, hour)
  }

  function handleSlotMouseEnter(dayName: string, hour: number) {
    if (!isDragging.current) return
    applySlotLocally(dayName, hour)
  }

  function applySlotLocally(dayName: string, hour: number) {
    const slotKey = `${dayName}-${hour}`
    if (draggedSlots.current.has(slotKey)) return
    draggedSlots.current.add(slotKey)

    const dow = DAY_OF_WEEK_MAP[dayName]
    const startTime = toTimeString(hour)
    const endTime = toTimeString(hour + 1)

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
            {HOURS.map(hour => (
              <tr key={hour}>
                <td style={{ padding: '2px 12px 2px 0', textAlign: 'right', fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                  {String(hour).padStart(2, '0')}:00
                </td>
                {DAYS.map(day => {
                  const active = isSlotActive(localGeneral, day, hour)
                  return (
                    <td key={day} style={{ padding: '2px 3px' }}>
                      <button
                        onMouseDown={() => handleSlotMouseDown(day, hour)}
                        onMouseEnter={() => handleSlotMouseEnter(day, hour)}
                        onDragStart={e => e.preventDefault()}
                        style={{
                          width: '90px', height: '32px',
                          borderRadius: '6px',
                          border: active ? '1px solid #FF8303' : '1px solid #E5E7EB',
                          backgroundColor: active ? '#FF8303' : '#F3F4F6',
                          color: active ? '#ffffff' : '#9CA3AF',
                          fontSize: '12px', fontWeight: '500',
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