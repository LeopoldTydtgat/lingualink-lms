'use client'

import { useState, useRef } from 'react'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { createClient } from '@/lib/supabase/client'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: (records: AvailabilityRecord[]) => void
}

interface ClassEvent {
  id: string
  starts_at: string
  ends_at: string
  student_name: string
}

// Format an ISO datetime string as a UTC ICS timestamp e.g. "20260414T080000Z"
function toIcsDate(isoStr: string): string {
  const d = new Date(isoStr)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// Build local date string YYYY-MM-DD without UTC conversion.
// toISOString() shifts the date when Cape Town (UTC+2) is ahead of UTC,
// so we build the string directly from local date parts instead.
function toLocalDateStr(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Merge consecutive general slots into single continuous background blocks.
// e.g. Mon 06:00-07:00 + 07:00-08:00 + ... + 12:00-13:00 → one block 06:00-13:00.
// We use 'background' display so they never stack alongside other events.
function expandGeneralSlots(
  generalSlots: AvailabilityRecord[],
  rangeStart: Date,
  rangeEnd: Date
): object[] {
  const events: object[] = []
  const cursor = new Date(rangeStart)

  while (cursor < rangeEnd) {
    const jsDay = cursor.getDay()
    const dateStr = toLocalDateStr(cursor)

    const daySlots = generalSlots
      .filter(s => s.day_of_week === jsDay && s.start_time && s.end_time)
      .sort((a, b) => (a.start_time! > b.start_time! ? 1 : -1))

    // Merge consecutive slots into single blocks
    const merged: { start: string; end: string }[] = []
    daySlots.forEach(slot => {
      const slotStart = slot.start_time!.slice(0, 5)
      const slotEnd = slot.end_time!.slice(0, 5)
      const last = merged[merged.length - 1]
      if (last && last.end === slotStart) {
        last.end = slotEnd
      } else {
        merged.push({ start: slotStart, end: slotEnd })
      }
    })

    merged.forEach((block, i) => {
      events.push({
        id: `general-${dateStr}-${i}`,
        title: '',
        start: `${dateStr}T${block.start}`,
        end: `${dateStr}T${block.end}`,
        // 'background' renders as a tint behind the calendar grid.
        // It never stacks with other events — it just sits behind them.
        display: 'background',
        backgroundColor: '#FED7AA', // soft orange tint — matches brand colour
        overlap: false,
        extendedProps: { type: 'general' },
      })
    })

    cursor.setDate(cursor.getDate() + 1)
  }

  return events
}

export default function DayToDay({ profile, availability, onAvailabilityChange }: Props) {
  const supabase = createClient()
  const calendarRef = useRef<FullCalendar>(null)

  const [classes, setClasses] = useState<ClassEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [mode, setMode] = useState<null | 'available' | 'unavailable'>(null)
  const [visibleRange, setVisibleRange] = useState<{ start: Date; end: Date } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState('')

  async function fetchClassesForRange(startStr: string, endStr: string) {
    setIsLoading(true)
    const { data } = await supabase
      .from('classes')
      .select(`id, starts_at, ends_at, students ( full_name )`)
      .eq('teacher_id', profile.id)
      .gte('starts_at', startStr)
      .lte('starts_at', endStr)
      .neq('status', 'cancelled')

    if (data) {
      setClasses(
        data.map((c: any) => ({
          id: c.id,
          starts_at: c.starts_at,
          ends_at: c.ends_at,
          student_name: c.students?.full_name ?? 'Unknown student',
        }))
      )
    }
    setIsLoading(false)
  }

  function buildEvents() {
    const events: object[] = []

    // 1. Weekly recurring slots — soft orange background tint, no text, never stacks
    if (visibleRange) {
      const generalSlots = availability.filter(a => a.type === 'general')
      events.push(...expandGeneralSlots(generalSlots, visibleRange.start, visibleRange.end))
    }

    // 2. Specific availability — solid green block, no label needed
    availability
      .filter(a => a.type === 'specific' && a.is_available)
      .forEach(a => {
        if (!a.start_at || !a.end_at) return
        events.push({
          id: `avail-${a.id}`,
          title: '',
          start: a.start_at,
          end: a.end_at,
          backgroundColor: '#16A34A',
          borderColor: '#15803D',
          textColor: '#ffffff',
          extendedProps: { type: 'specific', recordId: a.id },
        })
      })

    // 3. Unavailability — solid red block, no label needed
    availability
      .filter(a => (a.type === 'specific' || a.type === 'holiday') && !a.is_available)
      .forEach(a => {
        if (!a.start_at || !a.end_at) return
        events.push({
          id: `unavail-${a.id}`,
          title: '',
          start: a.start_at,
          end: a.end_at,
          backgroundColor: '#DC2626',
          borderColor: '#B91C1C',
          textColor: '#ffffff',
          extendedProps: { type: 'specific', recordId: a.id },
        })
      })

    // 4. Booked classes — orange with student name (the only labelled events)
    classes.forEach(c => {
      events.push({
        id: `class-${c.id}`,
        title: c.student_name,
        start: c.starts_at,
        end: c.ends_at,
        backgroundColor: '#FF8303',
        borderColor: '#FF8303',
        textColor: '#ffffff',
        extendedProps: { type: 'class' },
      })
    })

    return events
  }

  // Click a green or red block to delete it
  async function handleEventClick(info: any) {
    const { type, recordId } = info.event.extendedProps
    if (type !== 'specific') return
    const eventStart = info.event.startStr.slice(0, 10)
    const today = toLocalDateStr(new Date())
    if (eventStart < today) return

    setPendingDelete(recordId)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const { error } = await supabase.from('availability').delete().eq('id', pendingDelete)
    if (!error) {
      onAvailabilityChange(availability.filter(a => a.id !== pendingDelete))
    }
    setPendingDelete(null)
  }

  function exportToCalendar() {
    if (classes.length === 0) {
      setExportMsg('No classes this week to export')
      setTimeout(() => setExportMsg(''), 3000)
      return
    }
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//LinguaLink Online//Teacher Portal//EN',
    ]
    classes.forEach(c => {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${c.id}`,
        `DTSTART:${toIcsDate(c.starts_at)}`,
        `DTEND:${toIcsDate(c.ends_at)}`,
        `SUMMARY:${c.student_name}`,
        `DESCRIPTION:Class with ${c.student_name}`,
        'END:VEVENT',
      )
    })
    lines.push('END:VCALENDAR')
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lingualink-classes-${visibleRange ? toLocalDateStr(visibleRange.start) : 'week'}.ics`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Click or drag on calendar while a mode is active
  async function handleDateSelect(info: any) {
    if (!mode) return
    const today = toLocalDateStr(new Date())
    const selectedDate = info.startStr.slice(0, 10)
    if (selectedDate < today) return
    setIsSaving(true)

    const { data, error } = await supabase
      .from('availability')
      .insert({
        teacher_id: profile.id,
        type: 'specific',
        start_at: info.startStr,
        end_at: info.endStr,
        is_available: mode === 'available',
      })
      .select()
      .single()

    if (!error && data) {
      onAvailabilityChange([...availability, data as AvailabilityRecord])
    }

    setIsSaving(false)
    calendarRef.current?.getApi().unselect()
  }

  return (
    <div>
      <style>{`
        .fc-event:hover {
          filter: brightness(0.85);
          cursor: pointer;
        }
      `}</style>

      {/* Mode buttons */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setMode(mode === 'available' ? null : 'available')}
          style={{
            padding: '8px 16px',
            backgroundColor: mode === 'available' ? '#15803D' : '#16A34A',
            color: '#ffffff',
            border: mode === 'available' ? '2px solid #14532D' : '2px solid transparent',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: mode === 'available' ? 'inset 0 2px 4px rgba(0,0,0,0.2)' : 'none',
          }}
        >
          {mode === 'available' ? '✓ Adding Availability' : '+ Add Availability'}
        </button>

        <button
          onClick={() => setMode(mode === 'unavailable' ? null : 'unavailable')}
          style={{
            padding: '8px 16px',
            backgroundColor: mode === 'unavailable' ? '#B91C1C' : '#DC2626',
            color: '#ffffff',
            border: mode === 'unavailable' ? '2px solid #7F1D1D' : '2px solid transparent',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: mode === 'unavailable' ? 'inset 0 2px 4px rgba(0,0,0,0.2)' : 'none',
          }}
        >
          {mode === 'unavailable' ? '✓ Adding Unavailability' : '+ Add Unavailability'}
        </button>

        <span style={{ fontSize: '13px', color: '#6B7280' }}>
          {isSaving
            ? 'Saving...'
            : mode === 'available'
            ? 'Click or drag on the calendar to mark yourself available'
            : mode === 'unavailable'
            ? 'Click or drag on the calendar to mark yourself unavailable'
            : 'Select a mode on the left, then click or drag on the calendar'}
        </span>

        <button
          onClick={exportToCalendar}
          style={{
            marginLeft: 'auto',
            padding: '8px 16px',
            backgroundColor: '#ffffff',
            color: '#374151',
            border: '1px solid #E5E7EB',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
          }}
        >
          Export to Calendar
        </button>
      </div>
      {exportMsg && (
        <p style={{ fontSize: '12px', color: '#6B7280', marginBottom: '8px', textAlign: 'right' }}>
          {exportMsg}
        </p>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[
          { color: '#FF8303', label: 'Booked class' },
          { color: '#16A34A', label: 'Available (specific)' },
          { color: '#FED7AA', border: '#FB923C', label: 'Weekly availability' },
          { color: '#DC2626', label: 'Unavailable' },
        ].map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{
              width: '14px', height: '14px', borderRadius: '3px',
              backgroundColor: item.color,
              border: item.border ? `1px solid ${item.border}` : 'none',
            }} />
            <span style={{ fontSize: '12px', color: '#6B7280' }}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* Calendar */}
      <div style={{
        background: '#ffffff',
        borderRadius: '8px',
        padding: '16px',
        border: '1px solid #E5E7EB',
        cursor: mode ? 'crosshair' : 'default',
      }}>
        <FullCalendar
          ref={calendarRef}
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{
            left: 'prev,next',
            center: 'title',
            right: '',
          }}
          buttonText={{ prev: '←', next: '→' }}
          timeZone="local"
          datesSet={info => {
            setVisibleRange({ start: info.start, end: info.end })
            fetchClassesForRange(info.startStr, info.endStr)
          }}
          events={buildEvents()}
          selectable={!!mode}
          selectMirror={true}
          select={handleDateSelect}
          eventClick={handleEventClick}
          allDaySlot={false}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          slotDuration="00:30:00"
          slotLabelInterval="01:00:00"
          nowIndicator={true}
          height="auto"
          expandRows={true}
          eventDisplay="block"
          selectOverlap={event => event.extendedProps.type !== 'class'}
        />
      </div>

      <p style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '12px' }}>
        Click any green or red block to remove it. Booked classes cannot be removed here.
      </p>

      {pendingDelete && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            backgroundColor: '#ffffff', borderRadius: '12px', padding: '28px 32px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: '280px', textAlign: 'center',
          }}>
            <p style={{ fontSize: '15px', fontWeight: '600', color: '#111827', marginBottom: '20px' }}>
              Remove this block?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setPendingDelete(null)}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: '1px solid #D1D5DB',
                  backgroundColor: '#F3F4F6', color: '#374151', fontSize: '13px',
                  fontWeight: '600', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: 'none',
                  backgroundColor: '#DC2626', color: '#ffffff', fontSize: '13px',
                  fontWeight: '600', cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}