'use client'

import { useState, useRef, useMemo, useEffect } from 'react'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { createClient } from '@/lib/supabase/client'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string; timezone: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: (records: AvailabilityRecord[]) => void
}

interface ClassEvent {
  id: string
  scheduled_at: string
  duration_minutes: number
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

function localIsoToUtcIso(localIso: string, timezone: string): string {
  const [datePart, timePart] = localIso.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(probe)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  const diffMs = ((hour - get('hour')) * 60 + (minute - get('minute'))) * 60 * 1000
  const corrected = new Date(probe.getTime() + diffMs)
  const parts2 = formatter.formatToParts(corrected)
  const get2 = (type: string) => Number(parts2.find(p => p.type === type)?.value ?? '0')
  if (get2('hour') !== hour || get2('minute') !== minute) {
    const diffMs2 = ((hour - get2('hour')) * 60 + (minute - get2('minute'))) * 60 * 1000
    return new Date(corrected.getTime() + diffMs2).toISOString()
  }
  return corrected.toISOString()
}

export default function DayToDay({ profile, availability, onAvailabilityChange }: Props) {
  const supabase = createClient()
  const calendarRef = useRef<FullCalendar>(null)

  const [classes, setClasses] = useState<ClassEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [mode, setMode] = useState<null | 'available' | 'unavailable'>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMode(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      const scroller = document.querySelector('.fc-scroller-liquid-absolute') as HTMLElement
      if (scroller) scroller.scrollTop = scroller.scrollHeight * (3 / 18)
    }, 150)
    return () => clearTimeout(timer)
  }, [])

  // Store as strings so useMemo gets stable primitive deps — Date objects are never ===
  const [visibleRange, setVisibleRange] = useState<{ start: string; end: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState('')
  const [actionError, setActionError] = useState('')

  // Tracks the current visible range without causing the Realtime subscription to
  // re-subscribe on every week navigation. The subscription callback reads this ref
  // at event time so it always fetches the week the user is currently viewing.
  const visibleRangeRef = useRef<{ start: string; end: string } | null>(null)
  useEffect(() => {
    visibleRangeRef.current = visibleRange
  }, [visibleRange])

  async function fetchClassesForRange(startStr: string, endStr: string) {
    setIsLoading(true)
    const { data } = await supabase
      .from('lessons')
      .select(`id, scheduled_at, duration_minutes, students ( full_name )`)
      .eq('teacher_id', profile.id)
      .gte('scheduled_at', startStr)
      .lte('scheduled_at', endStr)
      .neq('status', 'cancelled')

    if (data) {
      setClasses(
        data.map((c: any) => {
          const student = Array.isArray(c.students) ? c.students[0] : c.students
          return {
            id: c.id,
            scheduled_at: c.scheduled_at,
            duration_minutes: c.duration_minutes,
            student_name: student?.full_name ?? 'Unknown student',
          }
        })
      )
    }
    setIsLoading(false)
  }

  // Subscribe to any change on this teacher's lessons and re-fetch the visible week.
  // profile.id is stable for the lifetime of the component so the effect runs once.
  useEffect(() => {
    const channel = supabase
      .channel(`lessons-daytodday-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lessons',
          filter: `teacher_id=eq.${profile.id}`,
        },
        () => {
          const range = visibleRangeRef.current
          if (range) fetchClassesForRange(range.start, range.end)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [profile.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Memoised so FullCalendar only receives a new events array when the underlying
  // data actually changes — not on every state update (mode, isSaving, actionError, etc.).
  // Without this, every button click causes FullCalendar to re-render its grid,
  // cancelling in-flight selections and resetting the scroll position (Issue 5).
  const calendarEvents = useMemo(() => {
    const events: object[] = []

    // 1. Weekly recurring slots — soft orange background tint
    if (visibleRange) {
      const generalSlots = availability.filter(a => a.type === 'general')
      events.push(...expandGeneralSlots(
        generalSlots,
        new Date(visibleRange.start),
        new Date(visibleRange.end),
      ))
    }

    // 2. Specific availability — solid green block
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

    // 3. Unavailability — solid red block
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
      const endsAt = new Date(new Date(c.scheduled_at).getTime() + c.duration_minutes * 60 * 1000).toISOString()
      events.push({
        id: `class-${c.id}`,
        title: c.student_name,
        start: c.scheduled_at,
        end: endsAt,
        backgroundColor: '#FF8303',
        borderColor: '#FF8303',
        textColor: '#ffffff',
        extendedProps: { type: 'class' },
      })
    })

    return events
  }, [availability, classes, visibleRange?.start, visibleRange?.end])

  // Click a green or red block to delete it
  async function handleEventClick(info: any) {
    const { type, recordId } = info.event.extendedProps
    if (type !== 'specific') return

    setActionError('')
    setPendingDelete(recordId)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const res = await fetch(`/api/teacher/availability/${pendingDelete}`, { method: 'DELETE' })
    if (res.ok) {
      onAvailabilityChange(availability.filter(a => a.id !== pendingDelete))
    } else {
      const body = await res.json().catch(() => ({}))
      setActionError(body.error ?? 'Failed to remove block. Please try again.')
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
      const endsAt = new Date(new Date(c.scheduled_at).getTime() + c.duration_minutes * 60 * 1000).toISOString()
      lines.push(
        'BEGIN:VEVENT',
        `UID:${c.id}`,
        `DTSTART:${toIcsDate(c.scheduled_at)}`,
        `DTEND:${toIcsDate(endsAt)}`,
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
    a.download = `lingualink-classes-${visibleRange ? visibleRange.start.slice(0, 10) : 'week'}.ics`
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
    setActionError('')

    const res = await fetch('/api/teacher/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacher_id: profile.id,
        type: 'specific',
        start_at: localIsoToUtcIso(info.startStr, profile.timezone),
        end_at: localIsoToUtcIso(info.endStr, profile.timezone),
        is_available: mode === 'available',
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data) {
        onAvailabilityChange([...availability, data as AvailabilityRecord])
      }
    } else {
      const body = await res.json().catch(() => ({}))
      setActionError(body.error ?? 'Failed to save. Please try again.')
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
        .fc-day-today {
          background-color: #EFF6FF !important;
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
            : 'Select a mode, drag to add blocks. Press Esc to exit.'}
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

      {actionError && (
        <p style={{ fontSize: '13px', color: '#DC2626', marginBottom: '8px', padding: '8px 12px', backgroundColor: '#FEF2F2', borderRadius: '6px', border: '1px solid #FECACA' }}>
          {actionError}
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
        overflowY: 'auto',
      }}>
        <FullCalendar
          ref={calendarRef}
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{
            left: 'prev',
            center: 'title',
            right: 'next',
          }}
          buttonText={{ prev: '←', next: '→' }}
          timeZone="local"
          datesSet={info => {
            // Only update state when the range actually changes — prevents unnecessary
            // re-renders that would pass a new events array to FullCalendar mid-interaction.
            setVisibleRange(prev => {
              if (prev?.start === info.startStr && prev?.end === info.endStr) return prev
              return { start: info.startStr, end: info.endStr }
            })
            fetchClassesForRange(info.startStr, info.endStr)
          }}
          events={calendarEvents}
          selectable={!!mode}
          selectMirror={true}
          select={handleDateSelect}
          eventClick={handleEventClick}
          allDaySlot={false}
          slotMinTime="05:00:00"
          slotMaxTime="23:00:00"
          slotDuration="00:30:00"
          slotLabelInterval="01:00:00"
          nowIndicator={true}
          height="700px"
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
