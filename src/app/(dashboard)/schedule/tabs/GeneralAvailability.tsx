'use client'

import { useState, useEffect, useRef, useMemo, Dispatch, SetStateAction } from 'react'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: Dispatch<SetStateAction<AvailabilityRecord[]>>
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

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12am'
  if (hour < 12) return `${hour}am`
  if (hour === 12) return '12pm'
  return `${hour - 12}pm`
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

function isSlotActive(records: AvailabilityRecord[], dayName: string, hour: number, minute: number): boolean {
  const dow = DAY_OF_WEEK_MAP[dayName]
  return records.some(
    a =>
      a.day_of_week === dow &&
      a.start_time === toTimeString(hour, minute) &&
      a.end_time === endTimeString(hour, minute)
  )
}

// Returns all slot keys between fromKey and toKey (exclusive of fromKey, inclusive of toKey).
// If the keys are on different days, returns just [toKey] — no cross-day interpolation.
function slotKeysBetween(fromKey: string, toKey: string): string[] {
  const [fromDay, fromHourStr, fromMinStr] = fromKey.split('-')
  const [toDay, toHourStr, toMinStr] = toKey.split('-')
  if (fromDay !== toDay) return [toKey]
  const fromIdx = SLOTS.findIndex(s => s.hour === parseInt(fromHourStr) && s.minute === parseInt(fromMinStr))
  const toIdx = SLOTS.findIndex(s => s.hour === parseInt(toHourStr) && s.minute === parseInt(toMinStr))
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return [toKey]
  const min = Math.min(fromIdx, toIdx)
  const max = Math.max(fromIdx, toIdx)
  const keys: string[] = []
  for (let i = min; i <= max; i++) {
    if (i === fromIdx) continue
    const { hour, minute } = SLOTS[i]
    keys.push(`${toDay}-${hour}-${minute}`)
  }
  return keys
}

export default function GeneralAvailability({ profile, availability, onAvailabilityChange }: Props) {
  const generalSlots = useMemo(
    () => availability.filter(a => a.type === 'general'),
    [availability]
  )

  const isDragging = useRef(false)
  const dragMode = useRef<'on' | 'off'>('on')
  const draggedSlots = useRef<Set<string>>(new Set())
  const lastSlotKey = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [saveError, setSaveError] = useState('')
  const [dragPreview, setDragPreview] = useState<Set<string>>(new Set())

  const runMap = useMemo(() => {
    const map = new Map<string, { isRunStart: boolean; runLength: number }>()
    for (const day of DAYS) {
      let i = 0
      while (i < SLOTS.length) {
        const { hour, minute } = SLOTS[i]
        if (!isSlotActive(generalSlots, day, hour, minute)) { i++; continue }
        let j = i
        while (j < SLOTS.length && isSlotActive(generalSlots, day, SLOTS[j].hour, SLOTS[j].minute)) j++
        const runLength = j - i
        map.set(`${day}-${hour}-${minute}`, { isRunStart: true, runLength })
        for (let k = i + 1; k < j; k++) {
          const s = SLOTS[k]
          map.set(`${day}-${s.hour}-${s.minute}`, { isRunStart: false, runLength: 0 })
        }
        i = j
      }
    }
    return map
  }, [generalSlots])

  // For each contiguous run of preview slots per day, maps the topmost slot key to its
  // "9am - 11:30am" label so the preview overlay can show it only on the first cell.
  const dragPreviewRuns = useMemo(() => {
    const labels = new Map<string, string>()
    for (const day of DAYS) {
      const dayKeys = Array.from(dragPreview).filter(k => k.startsWith(`${day}-`))
      if (dayKeys.length === 0) continue
      const indexed = dayKeys
        .map(k => {
          const parts = k.split('-')
          const idx = SLOTS.findIndex(s => s.hour === parseInt(parts[1]) && s.minute === parseInt(parts[2]))
          return { key: k, idx }
        })
        .filter(x => x.idx !== -1)
        .sort((a, b) => a.idx - b.idx)
      let runStart = 0
      while (runStart < indexed.length) {
        let runEnd = runStart
        while (runEnd + 1 < indexed.length && indexed[runEnd + 1].idx === indexed[runEnd].idx + 1) runEnd++
        const { hour: sH, minute: sM } = SLOTS[indexed[runStart].idx]
        const { hour: eH, minute: eM } = SLOTS[indexed[runEnd].idx]
        labels.set(indexed[runStart].key, timeRangeLabel12(sH * 60 + sM, eH * 60 + eM + 30))
        runStart = runEnd + 1
      }
    }
    return labels
  }, [dragPreview])

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
    function abortDrag() {
      if (!isDragging.current) return
      isDragging.current = false
      draggedSlots.current = new Set()
      setDragPreview(new Set())
    }

    function handleBlur() {
      abortDrag()
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') abortDrag()
    }

    async function handleMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false
      lastSlotKey.current = null

      const slots = Array.from(draggedSlots.current)
      draggedSlots.current = new Set()
      if (slots.length === 0) {
        setDragPreview(new Set())
        return
      }

      // Snapshot of general slots at the moment the drag committed; used for dedupe
      // and for finding records to delete. Functional setState handles concurrent drags.
      const generalAtDrag = availability.filter(a => a.type === 'general')

      if (dragMode.current === 'on') {
        const slotsToInsert = slots.filter(slotKey => {
          const [dayName, hourStr, minuteStr] = slotKey.split('-')
          const hour = parseInt(hourStr)
          const minute = parseInt(minuteStr)
          const dow = DAY_OF_WEEK_MAP[dayName]
          return !generalAtDrag.some(
            a => a.day_of_week === dow &&
              a.start_time === toTimeString(hour, minute) &&
              a.end_time === endTimeString(hour, minute)
          )
        })

        if (slotsToInsert.length === 0) {
          setDragPreview(new Set())
          return
        }

        const tempRecords: AvailabilityRecord[] = slotsToInsert.map(slotKey => {
          const [dayName, hourStr, minuteStr] = slotKey.split('-')
          const hour = parseInt(hourStr)
          const minute = parseInt(minuteStr)
          return {
            id: `temp-${slotKey}`,
            teacher_id: profile.id,
            type: 'general',
            day_of_week: DAY_OF_WEEK_MAP[dayName],
            start_time: toTimeString(hour, minute),
            end_time: endTimeString(hour, minute),
            is_available: true,
            start_at: null,
            end_at: null,
          }
        })
        const tempIds = new Set(tempRecords.map(r => r.id))

        // Optimistic insert — appends our temps to whatever the latest state is.
        onAvailabilityChange(prev => [...prev, ...tempRecords])
        setDragPreview(new Set())

        const inserts = slotsToInsert.map(slotKey => {
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
        const allOk = results.every(r => r.ok)
        if (allOk) {
          setSaveError('')
          const newRecords = results.map(r => r.data).filter(Boolean) as AvailabilityRecord[]
          // Strip our temps and append the canonical rows. Other concurrent updates
          // (other drags, other tabs) are preserved because we only touch our own ids.
          onAvailabilityChange(prev => [
            ...prev.filter(a => !tempIds.has(a.id)),
            ...newRecords,
          ])
        } else {
          setSaveError('Failed to save. Please try again.')
          // Strip only our temps — leave everything else (including concurrent drags) intact.
          onAvailabilityChange(prev => prev.filter(a => !tempIds.has(a.id)))
        }
      } else {
        const idsToDelete = slots
          .map(slotKey => {
            const [dayName, hourStr, minuteStr] = slotKey.split('-')
            const hour = parseInt(hourStr)
            const minute = parseInt(minuteStr)
            const dow = DAY_OF_WEEK_MAP[dayName]
            return generalAtDrag.find(
              a => a.day_of_week === dow &&
                a.start_time === toTimeString(hour, minute) &&
                a.end_time === endTimeString(hour, minute)
            )?.id
          })
          .filter((id): id is string => !!id && !id.startsWith('temp-'))

        if (idsToDelete.length === 0) {
          setDragPreview(new Set())
          return
        }

        const idSet = new Set(idsToDelete)
        // Snapshot the records we're removing so we can restore them on failure.
        const removedRecords = generalAtDrag.filter(a => idSet.has(a.id))

        // Optimistic delete — remove only the rows we own from the latest state.
        onAvailabilityChange(prev => prev.filter(a => !idSet.has(a.id)))
        setDragPreview(new Set())

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
        } else {
          setSaveError('Failed to remove slot(s). Please try again.')
          // Restore the records we removed; concurrent state changes are preserved.
          onAvailabilityChange(prev => [...prev, ...removedRecords])
        }
      }
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [availability, profile.id, onAvailabilityChange])

  function handleSlotMouseDown(dayName: string, hour: number, minute: number) {
    const active = isSlotActive(generalSlots, dayName, hour, minute)
    const slotKey = `${dayName}-${hour}-${minute}`
    isDragging.current = true
    dragMode.current = active ? 'off' : 'on'
    draggedSlots.current = new Set([slotKey])
    lastSlotKey.current = slotKey
    setSaveError('')
    setDragPreview(new Set([slotKey]))
  }

  function handleSlotMouseEnter(dayName: string, hour: number, minute: number) {
    if (!isDragging.current) return
    applySlotLocally(dayName, hour, minute)
  }

  function applySlotLocally(dayName: string, hour: number, minute: number) {
    const slotKey = `${dayName}-${hour}-${minute}`
    const newKeys: string[] = []

    if (lastSlotKey.current !== null) {
      const between = slotKeysBetween(lastSlotKey.current, slotKey)
      for (const key of between) {
        if (!draggedSlots.current.has(key)) {
          draggedSlots.current.add(key)
          newKeys.push(key)
        }
      }
    }
    lastSlotKey.current = slotKey

    if (!draggedSlots.current.has(slotKey)) {
      draggedSlots.current.add(slotKey)
      newKeys.push(slotKey)
    }

    if (newKeys.length === 0) return
    setDragPreview(prev => {
      const next = new Set(prev)
      for (const key of newKeys) next.add(key)
      return next
    })
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

      <div ref={scrollRef} className="overflow-x-auto select-none thin-scroll" style={{ maxHeight: '600px', overflowY: 'auto', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #9CA3AF' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '64px', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#ffffff', boxShadow: 'inset 0 -1px 0 #6B7280', borderRight: '1px solid #D1D5DB' }} />
              {DAYS.map(day => (
                <th
                  key={day}
                  style={{ padding: '12px 4px', textAlign: 'center', fontSize: '13px', fontWeight: '600', color: '#2C2C2A', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#ffffff', boxShadow: 'inset 0 -1px 0 #6B7280', borderRight: '1px solid #E5E7EB' }}
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
                <td style={{ padding: '1px 12px 1px 8px', textAlign: 'right', fontSize: '11px', color: '#4B5563', whiteSpace: 'nowrap', borderRight: '1px solid #D1D5DB', borderLeft: '1px solid #D1D5DB', backgroundColor: '#ffffff', height: 30, boxSizing: 'border-box' }}>
                  {minute === 0 ? formatHourLabel(hour) : null}
                </td>
                {DAYS.map(day => {
                  return (
                    <td key={day} style={{ padding: 0, borderRight: '1px solid #D1D5DB', position: 'relative', height: 30, boxSizing: 'border-box' }}>
                      <button
                        onMouseDown={() => handleSlotMouseDown(day, hour, minute)}
                        onMouseEnter={() => handleSlotMouseEnter(day, hour, minute)}
                        onDragStart={e => e.preventDefault()}
                        style={{
                          width: '100%',
                          height: '100%',
                          borderRadius: '4px',
                          border: 'none',
                          backgroundColor: 'transparent',
                          cursor: 'pointer',
                        }}
                      />
                      {(() => {
                        const meta = runMap.get(`${day}-${hour}-${minute}`)
                        if (!meta || !meta.isRunStart) return null
                        const heightPx = meta.runLength * 30 - 2
                        const endIdx = SLOTS.findIndex(s => s.hour === hour && s.minute === minute) + meta.runLength
                        const endSlot = SLOTS[endIdx] ?? { hour: 24, minute: 0 }
                        return (
                          <div style={{
                            position: 'absolute',
                            top: -1, left: 0, right: 0,
                            height: heightPx + 1,
                            backgroundColor: '#F1F5F9',
                            border: '1px solid #E2E8F0',
                            borderRadius: '4px',
                            padding: '4px 6px',
                            pointerEvents: 'none',
                            zIndex: 1,
                            overflow: 'hidden',
                          }}>
                            <div style={{ fontSize: '10px', color: '#1F2937', lineHeight: 1.2 }}>{timeRangeLabel12(hour * 60 + minute, endSlot.hour * 60 + endSlot.minute)}</div>
                            <div style={{ fontSize: '11px', color: '#1F2937', fontWeight: 500, lineHeight: 1.3, marginTop: '2px' }}>Weekly availability</div>
                          </div>
                        )
                      })()}
                      {(() => {
                        const slotKey = `${day}-${hour}-${minute}`
                        if (!dragPreview.has(slotKey)) return null
                        const isAddPreview = dragMode.current === 'on'
                        const label = dragPreviewRuns.get(slotKey)
                        return (
                          <div style={{
                            position: 'absolute',
                            top: -1, left: 0, right: 0,
                            height: 29,
                            backgroundColor: isAddPreview ? '#F1F5F9' : 'transparent',
                            backgroundImage: isAddPreview
                              ? undefined
                              : 'repeating-linear-gradient(45deg, rgba(220,38,38,0.18) 0 4px, transparent 4px 8px)',
                            border: isAddPreview
                              ? '1px solid #E2E8F0'
                              : '1px dashed rgba(220, 38, 38, 0.5)',
                            borderRadius: '4px',
                            pointerEvents: 'none',
                            zIndex: 2,
                            overflow: 'hidden',
                            padding: label ? '2px 4px' : undefined,
                          }}>
                            {label && (
                              <div style={{ fontSize: '10px', color: '#6B7280', lineHeight: 1.2, pointerEvents: 'none' }}>{label}</div>
                            )}
                          </div>
                        )
                      })()}
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
