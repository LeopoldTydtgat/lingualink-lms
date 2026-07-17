'use client'

import { useState, useEffect, useRef, useMemo, Dispatch, SetStateAction } from 'react'
import { Clock } from 'lucide-react'
import { AvailabilityRecord } from '../ScheduleClient'
import { weeklyGeneralMinutes } from '@/lib/availability'

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
  return `${String(hour).padStart(2, '0')}:00`
}

function formatTime24(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function timeRangeLabel24(startMin: number, endMin: number): string {
  return `${formatTime24(startMin)} – ${formatTime24(endMin)}`
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

  const weeklyHours = useMemo(() => {
    const totalMinutes = weeklyGeneralMinutes(generalSlots)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return { hours, minutes }
  }, [generalSlots])

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
  // "09:00 – 11:30" label so the preview overlay can show it only on the first cell.
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
        labels.set(indexed[runStart].key, timeRangeLabel24(sH * 60 + sM, eH * 60 + eM + 30))
        runStart = runEnd + 1
      }
    }
    return labels
  }, [dragPreview])

  // NEW282: earliest weekly-slot start (minutes since midnight) across all days, or null when
  // no availability is set. Built from the local hour/minute parts of the TIME string — no
  // Date/UTC conversion. Feeds the default scroll position below.
  const earliestSlotMin = useMemo(() => {
    let earliest: number | null = null
    for (const a of generalSlots) {
      if (!a.start_time) continue
      const [h, m] = a.start_time.split(':').map(Number)
      const min = h * 60 + m
      if (earliest === null || min < earliest) earliest = min
    }
    return earliest
  }, [generalSlots])

  // NEW282: default the grid scroll to one hour before the earliest weekly slot so early
  // availability is visible without scrolling; fall back to 08:00 when nothing is set. Clamp
  // to the 00:00–23:30 grid, then map to a 30-min row index — preserving the original
  // offsetTop-based row-scroll mechanism. Runs once per mount: the tab remounts on entry and
  // availability is present synchronously from the server, matching the prior behaviour (and
  // avoiding a scroll jerk while the teacher edits slots).
  useEffect(() => {
    if (!scrollRef.current) return
    const targetMin = earliestSlotMin !== null
      ? Math.max(0, Math.min(23 * 60 + 30, earliestSlotMin - 60))
      : 8 * 60
    const rows = scrollRef.current.querySelectorAll('tr')
    const targetRow = rows[Math.round(targetMin / 30)]
    if (targetRow) {
      scrollRef.current.scrollTop = (targetRow as HTMLElement).offsetTop - 40
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          Set your recurring weekly availability. These slots appear on your Day to Day calendar and to students when booking. Click or drag to add slots; click or drag existing slots to erase them.
        </p>
      </div>

      {saveError && (
        <p style={{ fontSize: '13px', color: '#DC2626', marginBottom: '12px', padding: '8px 12px', backgroundColor: '#FEF2F2', borderRadius: '6px', border: '1px solid #FECACA' }}>
          {saveError}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: '#ffffff', border: '1px solid #f3f4f6', borderRadius: '12px', padding: '10px 16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '999px', backgroundColor: '#FF8303', flexShrink: 0, boxShadow: '0 2px 6px rgba(255,131,3,0.35)' }}>
            <Clock size={16} color="#ffffff" strokeWidth={2.5} />
          </span>
          <div>
            <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, lineHeight: 1.3 }}>Offering per week</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
              {weeklyHours.hours}h {String(weeklyHours.minutes).padStart(2, '0')}min
            </div>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto select-none thin-scroll" style={{ maxHeight: '600px', overflowY: 'auto', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #E0DFDC' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '64px', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#ffffff', boxShadow: 'inset 0 -1px 0 #E0DFDC', borderRight: '1px solid #F1F1F0' }} />
              {DAYS.map(day => (
                <th
                  key={day}
                  style={{ padding: '12px 4px', textAlign: 'center', fontSize: '13px', fontWeight: '500', color: '#111111', position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#ffffff', boxShadow: 'inset 0 -1px 0 #E0DFDC', borderRight: '1px solid #F1F1F0' }}
                >
                  {day.slice(0, 3)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLOTS.map(({ hour, minute }) => (
              <tr key={`${hour}-${minute}`} style={{ borderTop: minute === 0 ? '1px solid #E9EAEC' : '1px solid #F4F5F6' }}>
                <td style={{ padding: '1px 12px 1px 8px', textAlign: 'right', fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap', borderRight: '1px solid #F1F1F0', borderLeft: '1px solid #F1F1F0', backgroundColor: '#ffffff', height: 30, boxSizing: 'border-box' }}>
                  {minute === 0 ? formatHourLabel(hour) : null}
                </td>
                {DAYS.map(day => {
                  return (
                    <td key={day} style={{ padding: 0, borderRight: '1px solid #F1F1F0', position: 'relative', height: 30, boxSizing: 'border-box' }}>
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
                            backgroundColor: '#EDF2F7',
                            border: '1px solid #C9D4E2',
                            borderRadius: '6px',
                            padding: '5px 7px',
                            pointerEvents: 'none',
                            zIndex: 1,
                            overflow: 'hidden',
                          }}>
                            <div style={{ fontSize: '11.5px', fontWeight: 500, color: '#475569', lineHeight: 1.2 }}>
                              {timeRangeLabel24(hour * 60 + minute, endSlot.hour * 60 + endSlot.minute)}
                            </div>
                            {meta.runLength >= 2 && (
                              <div style={{ fontSize: '11px', color: '#64748B', lineHeight: 1.3, marginTop: '2px' }}>Weekly availability</div>
                            )}
                          </div>
                        )
                      })()}
                      {(() => {
                        const slotKey = `${day}-${hour}-${minute}`
                        if (!dragPreview.has(slotKey)) return null
                        const isAddPreview = dragMode.current === 'on'
                        const label = dragPreviewRuns.get(slotKey)
                        if (isAddPreview) {
                          const slotIdx = SLOTS.findIndex(s => s.hour === hour && s.minute === minute)
                          const nextSlotKey = slotIdx >= 0 && slotIdx < SLOTS.length - 1
                            ? `${day}-${SLOTS[slotIdx + 1].hour}-${SLOTS[slotIdx + 1].minute}`
                            : null
                          const isMultiSlot = label !== undefined && nextSlotKey !== null && dragPreview.has(nextSlotKey)
                          return (
                            <div style={{
                              position: 'absolute',
                              top: -1, left: 0, right: 0,
                              height: 29,
                              backgroundColor: '#DCFCE7',
                              border: '1px dashed #16A34A',
                              borderRadius: '6px',
                              pointerEvents: 'none',
                              zIndex: 2,
                              overflow: 'hidden',
                              padding: label ? '2px 4px' : undefined,
                            }}>
                              {label && (
                                isMultiSlot ? (
                                  <>
                                    <div style={{ fontSize: '11.5px', fontWeight: 500, color: '#15803D', lineHeight: 1.2 }}>Adding</div>
                                    <div style={{ fontSize: '11px', color: '#16A34A', lineHeight: 1.2 }}>{label}</div>
                                  </>
                                ) : (
                                  <div style={{ fontSize: '11.5px', fontWeight: 500, color: '#15803D', lineHeight: 1.2 }}>Adding · {label}</div>
                                )
                              )}
                            </div>
                          )
                        } else {
                          return (
                            <div style={{
                              position: 'absolute',
                              top: -1, left: 0, right: 0,
                              height: 29,
                              background: 'repeating-linear-gradient(45deg, rgba(220,38,38,0.16) 0 6px, rgba(220,38,38,0.04) 6px 12px)',
                              border: '1px dashed #DC2626',
                              borderRadius: '6px',
                              pointerEvents: 'none',
                              zIndex: 2,
                              overflow: 'hidden',
                              padding: label ? '2px 4px' : undefined,
                            }}>
                              {label && (
                                <div style={{ fontSize: '11px', fontWeight: 500, color: '#B91C1C', lineHeight: 1.2 }}>Erasing · {label}</div>
                              )}
                            </div>
                          )
                        }
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
