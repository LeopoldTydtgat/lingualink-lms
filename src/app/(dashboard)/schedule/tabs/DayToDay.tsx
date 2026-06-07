'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { localTimeToUtcMs } from '@/lib/availability'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
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

const SLOT_HEIGHT = 30
const START_HOUR = 5
const END_HOUR = 23
const SLOT_COUNT = 38                              // 05:00 → 23:30 in 30-min slots
const GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT       // 836px
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Format an ISO datetime string as a UTC ICS timestamp e.g. "20260414T080000Z"
function toIcsDate(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// Build local date string YYYY-MM-DD without UTC conversion.
function toLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localIsoToUtcIso(localIso: string, timezone: string): string {
  const [datePart, timePart] = localIso.split('T')
  const [hh, mm] = timePart.split(':')
  return new Date(localTimeToUtcMs(datePart, `${hh}:${mm}`, timezone)).toISOString()
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function getWeekStart(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  r.setDate(r.getDate() - r.getDay())  // Sunday-first
  return r
}

function startOfDayLocal(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

// Convert a "minutes since local midnight" value into a vertical pixel offset within the grid.
function pxFromMin(min: number): number {
  const offset = ((min - START_HOUR * 60) / 30) * SLOT_HEIGHT
  return Math.max(0, Math.min(GRID_HEIGHT, offset))
}

function formatTime(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12am'
  if (hour < 12) return `${hour}am`
  if (hour === 12) return '12pm'
  return `${hour - 12}pm`
}

function timeRangeLabel(startMin: number, endMin: number): string {
  return `${formatTime(startMin)} - ${formatTime(endMin)}`
}

function formatTime12(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  const period = h < 12 ? 'am' : 'pm'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`
}

function timeRangeLabel12(startMin: number, endMin: number): string {
  return `${formatTime12(startMin)} - ${formatTime12(endMin)}`
}

function weekLabel(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const sM = MONTHS_SHORT[weekStart.getMonth()]
  const eM = MONTHS_SHORT[end.getMonth()]
  if (weekStart.getFullYear() !== end.getFullYear()) {
    return `${sM} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${eM} ${end.getDate()}, ${end.getFullYear()}`
  }
  if (weekStart.getMonth() !== end.getMonth()) {
    return `${sM} ${weekStart.getDate()} – ${eM} ${end.getDate()}, ${weekStart.getFullYear()}`
  }
  return `${sM} ${weekStart.getDate()} – ${end.getDate()}, ${weekStart.getFullYear()}`
}

// Merge consecutive general slots (e.g. Mon 06:00-06:30 + 06:30-07:00) into single
// continuous blocks per day, so the orange tint renders as one band rather than stacking.
function expandGeneralSlots(
  generalSlots: AvailabilityRecord[],
  weekStart: Date
): Array<{ dayIdx: number; startMin: number; endMin: number }> {
  const blocks: Array<{ dayIdx: number; startMin: number; endMin: number }> = []
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const date = addDays(weekStart, dayIdx)
    const jsDay = date.getDay()
    const daySlots = generalSlots
      .filter(s => s.day_of_week === jsDay && s.start_time && s.end_time)
      .sort((a, b) => (a.start_time! > b.start_time! ? 1 : -1))

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

    merged.forEach(b => {
      const [sH, sM] = b.start.split(':').map(Number)
      const [eH, eM] = b.end.split(':').map(Number)
      blocks.push({ dayIdx, startMin: sH * 60 + sM, endMin: eH * 60 + eM })
    })
  }
  return blocks
}

interface SpecificBlock {
  dayIdx: number
  startMin: number
  endMin: number
  recordId: string
}

interface ClassBlock {
  dayIdx: number
  startMin: number
  endMin: number
  studentName: string
}

function expandSpecificBlocks(records: AvailabilityRecord[], weekStart: Date): SpecificBlock[] {
  const wsMid = startOfDayLocal(weekStart)
  const blocks: SpecificBlock[] = []
  for (const r of records) {
    if (!r.start_at || !r.end_at) continue
    const start = new Date(r.start_at)
    const end = new Date(r.end_at)
    const startSod = startOfDayLocal(start)
    const dayIdx = Math.floor((startSod - wsMid) / 86_400_000)
    if (dayIdx < 0 || dayIdx > 6) continue
    const startMin = start.getHours() * 60 + start.getMinutes()
    const endMin = startOfDayLocal(end) === startSod
      ? end.getHours() * 60 + end.getMinutes()
      : 24 * 60  // event spans midnight — clamp to end of day
    blocks.push({ dayIdx, startMin, endMin, recordId: r.id })
  }
  return blocks
}

function expandClassBlocks(classes: ClassEvent[], weekStart: Date): ClassBlock[] {
  const wsMid = startOfDayLocal(weekStart)
  const blocks: ClassBlock[] = []
  for (const c of classes) {
    const start = new Date(c.scheduled_at)
    const dayIdx = Math.floor((startOfDayLocal(start) - wsMid) / 86_400_000)
    if (dayIdx < 0 || dayIdx > 6) continue
    const startMin = start.getHours() * 60 + start.getMinutes()
    blocks.push({ dayIdx, startMin, endMin: startMin + c.duration_minutes, studentName: c.student_name })
  }
  return blocks
}

export default function DayToDay({ profile, availability, onAvailabilityChange }: Props) {
  const supabase = createClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  const [classes, setClasses] = useState<ClassEvent[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [mode, setMode] = useState<null | 'available' | 'unavailable'>(null)
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState('')
  const [actionError, setActionError] = useState('')
  const [drag, setDrag] = useState<null | { dayIdx: number; startSlot: number; endSlot: number }>(null)
  const [now, setNow] = useState<Date>(() => new Date())

  // Tracks the visible range without causing the Realtime subscription to re-subscribe
  // on every week navigation. The subscription callback reads this ref at event time
  // so it always fetches the week the user is currently viewing.
  const visibleRangeRef = useRef<{ start: string; end: string } | null>(null)

  // Mount-only scroll-to-08:00. 8:00 is 3 hours past START_HOUR = 6 slots * SLOT_HEIGHT.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (8 - START_HOUR) * 2 * SLOT_HEIGHT
    }
  }, [])

  // Esc clears mode (and any in-flight drag preview).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMode(null)
        setDrag(null)
        isDraggingRef.current = false
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Now-indicator tick — recompute every 60s.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Cancel any drag preview when mode is cleared.
  useEffect(() => {
    if (!mode) {
      isDraggingRef.current = false
      setDrag(null)
    }
  }, [mode])

  // Visible range derived from weekStart, in the same local-naive shape the original FC
  // datesSet callback produced — fetchClassesForRange is fed strings without TZ markers.
  const visibleRange = useMemo(() => ({
    start: `${toLocalDateStr(weekStart)}T00:00:00`,
    end: `${toLocalDateStr(addDays(weekStart, 7))}T00:00:00`,
  }), [weekStart])

  useEffect(() => {
    visibleRangeRef.current = visibleRange
  }, [visibleRange])

  async function fetchClassesForRange(startStr: string, endStr: string) {
    const { data } = await supabase
      .from('lessons')
      .select(`id, scheduled_at, duration_minutes, students ( full_name )`)
      .eq('teacher_id', profile.id)
      .gte('scheduled_at', startStr)
      .lte('scheduled_at', endStr)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))

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
  }

  // Refetch classes when the visible week changes.
  useEffect(() => {
    fetchClassesForRange(visibleRange.start, visibleRange.end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRange.start, visibleRange.end])

  // Realtime: any change to this teacher's lessons re-fetches the visible week.
  // profile.id is stable for the component's lifetime so this runs once.
  useEffect(() => {
    const channel = supabase
      .channel(`lessons-daytoday-${profile.id}`)
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

    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )

  const generalBlocks = useMemo(
    () => expandGeneralSlots(availability.filter(a => a.type === 'general'), weekStart),
    [availability, weekStart]
  )

  const greenBlocks = useMemo(
    () => expandSpecificBlocks(availability.filter(a => a.type === 'specific' && a.is_available), weekStart),
    [availability, weekStart]
  )

  const redBlocks = useMemo(
    () => expandSpecificBlocks(
      availability.filter(a => (a.type === 'specific' || a.type === 'holiday') && !a.is_available),
      weekStart
    ),
    [availability, weekStart]
  )

  const classBlocksList = useMemo(
    () => expandClassBlocks(classes, weekStart),
    [classes, weekStart]
  )

  // Today's column index, or -1 if today is outside the visible week.
  const todayIdx = useMemo(() => {
    const t = startOfDayLocal(new Date())
    const idx = Math.floor((t - startOfDayLocal(weekStart)) / 86_400_000)
    return idx >= 0 && idx <= 6 ? idx : -1
  }, [weekStart])

  function startDrag(dayIdx: number, slotIdx: number) {
    if (!mode) return
    const slotMs = weekDays[dayIdx].getTime() + (START_HOUR * 60 + slotIdx * 30) * 60_000
    if (slotMs < Date.now()) return
    isDraggingRef.current = true
    setDrag({ dayIdx, startSlot: slotIdx, endSlot: slotIdx })
  }

  function extendDrag(dayIdx: number, slotIdx: number) {
    if (!isDraggingRef.current || !drag) return
    if (dayIdx !== drag.dayIdx) return
    const slotMs = weekDays[dayIdx].getTime() + (START_HOUR * 60 + slotIdx * 30) * 60_000
    if (slotMs < Date.now()) return
    if (slotIdx === drag.endSlot) return
    setDrag({ ...drag, endSlot: slotIdx })
  }

  // Window-level mouseup commits the drag selection.
  useEffect(() => {
    async function onMouseUp() {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      const d = drag
      const m = mode
      setDrag(null)
      if (!d || !m) return

      const lo = Math.min(d.startSlot, d.endSlot)
      const hi = Math.max(d.startSlot, d.endSlot) + 1
      const date = weekDays[d.dayIdx]
      const dateStr = toLocalDateStr(date)
      const startMin = START_HOUR * 60 + lo * 30
      const endMin = START_HOUR * 60 + hi * 30
      const startStr = `${dateStr}T${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}:00`
      const endStr = `${dateStr}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`

      if (dateStr < toLocalDateStr(new Date())) return

      setIsSaving(true)
      setActionError('')

      const res = await fetch('/api/teacher/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacher_id: profile.id,
          type: 'specific',
          start_at: localIsoToUtcIso(startStr, profile.timezone),
          end_at: localIsoToUtcIso(endStr, profile.timezone),
          is_available: m === 'available',
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data) onAvailabilityChange([...availability, data as AvailabilityRecord])
      } else {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error ?? 'Failed to save. Please try again.')
      }
      setIsSaving(false)
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [drag, mode, weekDays, availability, profile.id, profile.timezone, onAvailabilityChange])

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
      const endsAt = new Date(new Date(c.scheduled_at).getTime() + c.duration_minutes * 60_000).toISOString()
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
    a.download = `lingualink-classes-${toLocalDateStr(weekStart)}.ics`
    a.click()
    URL.revokeObjectURL(url)
  }

  const dragPreview = useMemo(() => {
    if (!drag) return null
    const lo = Math.min(drag.startSlot, drag.endSlot)
    const hi = Math.max(drag.startSlot, drag.endSlot) + 1
    return {
      dayIdx: drag.dayIdx,
      topPx: lo * SLOT_HEIGHT,
      heightPx: (hi - lo) * SLOT_HEIGHT,
      startMin: START_HOUR * 60 + lo * 30,
      endMin: START_HOUR * 60 + hi * 30,
    }
  }, [drag])

  const nowMin = now.getHours() * 60 + now.getMinutes()
  const nowPx = (nowMin >= START_HOUR * 60 && nowMin <= END_HOUR * 60 + 30)
    ? pxFromMin(nowMin)
    : null

  function gotoWeek(delta: number) {
    setDrag(null)
    isDraggingRef.current = false
    setWeekStart(addDays(weekStart, delta))
  }

  return (
    <div>
      {/* Mode buttons + Export */}
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
          { color: '#C5E8C9', border: '#8FBF94', label: 'Available (specific)' },
          { color: '#F1F5F9', border: '#E2E8F0', label: 'Weekly availability' },
          { color: '#ECC4C4', border: '#C99090', label: 'Unavailable' },
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

      {/* Week navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', padding: '0 4px' }}>
        <button
          onClick={() => gotoWeek(-7)}
          aria-label="Previous week"
          style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff', color: '#374151', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}
        >
          ←
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: '#374151' }}>{weekLabel(weekStart)}</span>
        <button
          onClick={() => gotoWeek(7)}
          aria-label="Next week"
          style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff', color: '#374151', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}
        >
          →
        </button>
      </div>

      {/* Calendar grid */}
      <div
        ref={scrollRef}
        className="thin-scroll"
        style={{
          background: '#ffffff',
          borderRadius: '8px',
          padding: '0',
          border: '1px solid #9CA3AF',
          cursor: mode ? 'crosshair' : 'default',
          maxHeight: '700px',
          overflowY: 'auto',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '48px repeat(7, 1fr)', position: 'relative' }}>
          {/* Sticky header — corner cell */}
          <div style={{
            position: 'sticky', top: 0, zIndex: 10,
            backgroundColor: '#ffffff',
            borderBottom: '1px solid #6B7280',
            borderRight: '1px solid #D1D5DB',
            borderTopLeftRadius: '8px',
            minHeight: '54px',
          }} />

          {/* Sticky header — day cells */}
          {weekDays.map((d, i) => {
            const isHeaderToday = i === todayIdx
            return (
              <div key={`h-${i}`} style={{
                position: 'sticky', top: 0, zIndex: 10,
                backgroundColor: isHeaderToday ? '#F6C5B8' : '#ffffff',
                boxShadow: isHeaderToday ? 'inset 0 -3px 0 #A8533F' : undefined,
                borderBottom: isHeaderToday ? undefined : '1px solid #6B7280',
                borderRight: '1px solid #E5E7EB',
                textAlign: 'center',
                padding: '10px 4px',
                color: isHeaderToday ? '#5C1F0A' : '#2C2C2A',
                fontWeight: 600,
                fontSize: '13px',
                lineHeight: 1.2,
              }}>
                <div>{DAY_LABELS[i]}</div>
                <div style={{ fontSize: '11px', fontWeight: 500, color: isHeaderToday ? undefined : '#5F5E5A', opacity: isHeaderToday ? 0.8 : undefined }}>
                  {MONTHS_SHORT[d.getMonth()]} {d.getDate()}
                </div>
              </div>
            )
          })}

          {/* Time gutter */}
          <div style={{ gridRow: 2, gridColumn: 1, position: 'relative', height: GRID_HEIGHT, backgroundColor: '#ffffff', borderRight: '1px solid #D1D5DB' }}>
            {Array.from({ length: SLOT_COUNT }, (_, slotIdx) => {
              const min = (START_HOUR * 60) + slotIdx * 30
              const onTheHour = (slotIdx % 2) === 0
              return (
                <div key={slotIdx} style={{
                  position: 'absolute',
                  top: slotIdx * SLOT_HEIGHT,
                  left: 0,
                  right: 0,
                  height: SLOT_HEIGHT,
                  paddingRight: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  fontSize: '11px',
                  color: '#4B5563',
                  borderTop: '1px solid #E5E7EB',
                }}>
                  {onTheHour ? formatHourLabel(Math.floor(min / 60)) : ''}
                </div>
              )
            })}
            {todayIdx >= 0 && nowPx !== null && (
              <div style={{
                position: 'absolute',
                top: nowPx - 5,
                right: -1,
                width: 0, height: 0,
                borderTop: '5px solid transparent',
                borderBottom: '5px solid transparent',
                borderLeft: '7px solid #DC2626',
                pointerEvents: 'none',
                zIndex: 6,
              }} />
            )}
          </div>

          {/* Day columns */}
          {weekDays.map((day, dayIdx) => {
            const isToday = dayIdx === todayIdx
            return (
              <div key={`d-${dayIdx}`} style={{
                gridRow: 2,
                gridColumn: dayIdx + 2,
                position: 'relative',
                height: GRID_HEIGHT,
                borderRight: '1px solid #E5E7EB',
                backgroundColor: 'transparent',
              }}>
                {/* Slot cells (38) — drag interaction + past-slot fade */}
                {Array.from({ length: SLOT_COUNT }, (_, slotIdx) => {
                  const slotMs = day.getTime() + (START_HOUR * 60 + slotIdx * 30) * 60_000
                  const isPast = slotMs < Date.now()
                  const cellBg = isPast ? '#F9FAFB' : 'transparent'
                  const onTheHour = (slotIdx % 2) === 0
                  return (
                    <div
                      key={`s-${slotIdx}`}
                      onMouseDown={() => startDrag(dayIdx, slotIdx)}
                      onMouseEnter={() => extendDrag(dayIdx, slotIdx)}
                      style={{
                        position: 'absolute',
                        top: slotIdx * SLOT_HEIGHT,
                        left: 0,
                        right: 0,
                        height: SLOT_HEIGHT,
                        borderTop: onTheHour ? '1px solid #E5E7EB' : '1px solid #E5E7EB',
                        backgroundColor: cellBg,
                        zIndex: 0,
                      }}
                    />
                  )
                })}

                {/* Layer 0: weekly recurring (orange tint, non-interactive) */}
                {generalBlocks.filter(b => b.dayIdx === dayIdx).map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  return (
                    <div key={`g-${i}`} style={{
                      position: 'absolute',
                      top, left: 0, right: 0, height,
                      backgroundColor: '#F1F5F9',
                      border: '1px solid #E2E8F0',
                      borderRadius: '4px',
                      pointerEvents: 'none',
                      zIndex: 1,
                    }} />
                  )
                })}

                {/* Layer 1: specific available (green) */}
                {greenBlocks.filter(b => b.dayIdx === dayIdx).map(b => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  return (
                    <div
                      key={`av-${b.recordId}`}
                      onClick={() => { setActionError(''); setPendingDelete(b.recordId) }}
                      style={{
                        position: 'absolute',
                        top, left: '2px', right: '2px', height,
                        backgroundColor: '#C5E8C9',
                        border: '1px solid #8FBF94',
                        borderRadius: '4px',
                        color: '#2F5D33',
                        fontSize: '11px',
                        padding: '2px 4px',
                        cursor: 'pointer',
                        zIndex: 2,
                        overflow: 'hidden',
                        lineHeight: 1.2,
                      }}
                    >
                      {timeRangeLabel12(b.startMin, b.endMin)}
                    </div>
                  )
                })}

                {/* Layer 1: specific unavailable + holiday (red) */}
                {redBlocks.filter(b => b.dayIdx === dayIdx).map(b => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  return (
                    <div
                      key={`un-${b.recordId}`}
                      onClick={() => { setActionError(''); setPendingDelete(b.recordId) }}
                      style={{
                        position: 'absolute',
                        top, left: '2px', right: '2px', height,
                        backgroundColor: '#ECC4C4',
                        border: '1px solid #C99090',
                        borderRadius: '4px',
                        color: '#7F1D1D',
                        fontSize: '11px',
                        padding: '2px 4px',
                        cursor: 'pointer',
                        zIndex: 2,
                        overflow: 'hidden',
                        lineHeight: 1.2,
                      }}
                    >
                      {timeRangeLabel12(b.startMin, b.endMin)}
                    </div>
                  )
                })}

                {/* Layer 2: booked classes (orange, not deletable here) */}
                {classBlocksList.filter(b => b.dayIdx === dayIdx).map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  return (
                    <div key={`cl-${i}`} style={{
                      position: 'absolute',
                      top, left: '2px', right: '2px', height,
                      backgroundColor: '#FF8303',
                      border: '1px solid rgba(255, 131, 3, 0.55)',
                      borderRadius: '4px',
                      color: '#ffffff',
                      fontSize: '11px',
                      padding: '2px 4px',
                      cursor: 'default',
                      zIndex: 3,
                      overflow: 'hidden',
                      lineHeight: 1.2,
                    }}>
                      <div>{timeRangeLabel12(b.startMin, b.endMin)}</div>
                      <div style={{ fontWeight: 600 }}>{b.studentName}</div>
                    </div>
                  )
                })}

                {/* Drag preview */}
                {dragPreview && dragPreview.dayIdx === dayIdx && (
                  <div style={{
                    position: 'absolute',
                    top: dragPreview.topPx,
                    height: dragPreview.heightPx,
                    left: '2px', right: '2px',
                    backgroundColor: mode === 'available' ? 'rgba(22,163,74,0.4)' : 'rgba(220,38,38,0.4)',
                    border: `1px solid ${mode === 'available' ? '#15803D' : '#B91C1C'}`,
                    borderRadius: '4px',
                    pointerEvents: 'none',
                    zIndex: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ffffff',
                    fontSize: '12px',
                    fontWeight: 600,
                    textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                  }}>
                    {timeRangeLabel12(dragPreview.startMin, dragPreview.endMin)}
                  </div>
                )}

                {/* Now indicator (red line, today only) */}
                {isToday && nowPx !== null && (
                  <div style={{
                    position: 'absolute',
                    top: nowPx - 1,
                    left: 0, right: 0,
                    height: '2px',
                    backgroundColor: '#DC2626',
                    pointerEvents: 'none',
                    zIndex: 5,
                  }} />
                )}
              </div>
            )
          })}
        </div>
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
