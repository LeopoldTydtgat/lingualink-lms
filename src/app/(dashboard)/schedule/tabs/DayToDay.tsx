'use client'

import { useState, useEffect, useRef, useMemo, Dispatch, SetStateAction } from 'react'
import { createClient } from '@/lib/supabase/client'
import { localTimeToUtcMs } from '@/lib/availability'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { getMondayWeekStart, addDays, getWeekDays, formatWeekLabel } from '@/lib/utils/week'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'
import { Download } from 'lucide-react'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string; timezone: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: Dispatch<SetStateAction<AvailabilityRecord[]>>
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
// Monday-first; index-aligned with getWeekDays(weekStart) — DAY_LABELS[i] labels weekDays[i].
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Format an ISO datetime string as a UTC ICS timestamp e.g. "20260414T080000Z"
function toIcsDate(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// Escape a TEXT value for ICS (RFC 5545): backslash first, then ';' ',' and newlines.
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n/g, '\\n')
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

function startOfDayLocal(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

// ─── Profile-timezone frame helpers ───────────────────────────────────────────
// The whole grid operates in ONE frame: the teacher's profile timezone. Day
// columns are profile-tz calendar dates carried as browser-local Date "holders"
// (local midnight of that calendar date). Holders are used ONLY for calendar
// math (getMondayWeekStart / addDays / day diffs / labels) — never as instants.
// Every stored instant (scheduled_at, start_at/end_at, now) is converted to
// profile-tz wall-clock parts via utcInstantToTzParts before touching the grid,
// so a block dragged at 09:00 renders at 09:00 for every viewer in every
// browser timezone — matching the write path, which already stores through
// profile.timezone.

// Day index (0–6) of a calendar-date holder within the visible week, or -1
// outside it. Math.round (not floor) absorbs the ±1h that a browser-local DST
// transition inside the week puts between local midnights.
function dayIndexInWeek(dateHolder: Date, weekStart: Date): number {
  const idx = Math.round((startOfDayLocal(dateHolder) - startOfDayLocal(weekStart)) / 86_400_000)
  return idx >= 0 && idx <= 6 ? idx : -1
}

// Holder for the calendar date currently showing in `tz`. Throws on an invalid
// tz (Intl) — call with the validated display timezone.
function tzTodayDate(tz: string): Date {
  const p = utcInstantToTzParts(new Date(), tz)
  return new Date(p.year, p.month - 1, p.day)
}

// YYYY-MM-DD calendar date of a stored UTC instant in `tz` — the profile-tz
// counterpart of toLocalDateStr, for keying instants against holder dates.
function tzDateStr(instant: string | Date, tz: string): string {
  const p = utcInstantToTzParts(instant, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
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
  return `${pad(hour)}:00`
}

function timeRangeLabel(startMin: number, endMin: number): string {
  return `${formatTime(startMin)} \u2013 ${formatTime(endMin)}`
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
  endMs: number  // true end instant (ms since epoch) — past-ness is an instant comparison, frame-free
}

function expandSpecificBlocks(records: AvailabilityRecord[], weekStart: Date, tz: string): SpecificBlock[] {
  const blocks: SpecificBlock[] = []
  for (const r of records) {
    if (!r.start_at || !r.end_at) continue

    // Holidays are always whole-day and may span multiple calendar days. Emit a
    // full-column block for every visible-week day whose local midnight falls within
    // the holiday's [start_at, end_at] date span (inclusive of both end days). We
    // iterate the week's 7 day-indices and test span membership rather than keying off
    // the start day, so a holiday that began in a previous week still paints all of its
    // covered days in this week. start/end-of-day extent matches the existing clamped
    // full-column block (startMin 0 → endMin 24*60). 'specific' blocks keep their
    // original single-day, real-minute placement below.
    if (r.type === 'holiday') {
      // NEW174: a holiday is a span of calendar DATES, not an instant. Derive the
      // start/end day from the stored date portion (YYYY-MM-DD) built in the LOCAL
      // frame, so a UTC-pinned end like 2026-10-06T23:59:59+00 is not pushed to the
      // next day when localised in a UTC+ zone. Never localise the stored instant
      // (new Date(r.start_at)) for holiday span bounds.
      const [sy, sm, sd] = r.start_at.split('T')[0].split('-').map(Number)
      const [ey, em, ed] = r.end_at.split('T')[0].split('-').map(Number)
      const spanStartSod = new Date(sy, sm - 1, sd).getTime()
      const spanEndSod = new Date(ey, em - 1, ed).getTime()
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const dayMid = startOfDayLocal(addDays(weekStart, dayIdx))
        if (dayMid >= spanStartSod && dayMid <= spanEndSod) {
          blocks.push({ dayIdx, startMin: 0, endMin: 24 * 60, recordId: r.id })
        }
      }
      continue
    }

    // Timed 'specific' blocks: convert the stored UTC instants to PROFILE-TZ
    // wall-clock parts (never browser-local getHours) so the block renders at
    // the wall-clock it was dragged at, for every viewer. The write path in
    // the commit handler already stores through profile.timezone — this makes
    // the render frame match it.
    const s = utcInstantToTzParts(r.start_at, tz)
    const e = utcInstantToTzParts(r.end_at, tz)
    const dayIdx = dayIndexInWeek(new Date(s.year, s.month - 1, s.day), weekStart)
    if (dayIdx === -1) continue
    const startMin = s.hour * 60 + s.minute
    const sameDay = s.year === e.year && s.month === e.month && s.day === e.day
    const endMin = sameDay
      ? e.hour * 60 + e.minute
      : 24 * 60  // event spans midnight — clamp to end of day
    blocks.push({ dayIdx, startMin, endMin, recordId: r.id })
  }
  return blocks
}

function expandClassBlocks(classes: ClassEvent[], weekStart: Date, tz: string): ClassBlock[] {
  const blocks: ClassBlock[] = []
  for (const c of classes) {
    // Profile-tz wall-clock placement, matching expandSpecificBlocks above.
    const p = utcInstantToTzParts(c.scheduled_at, tz)
    const dayIdx = dayIndexInWeek(new Date(p.year, p.month - 1, p.day), weekStart)
    if (dayIdx === -1) continue
    const startMin = p.hour * 60 + p.minute
    blocks.push({
      dayIdx,
      startMin,
      endMin: startMin + c.duration_minutes,
      studentName: c.student_name,
      endMs: new Date(c.scheduled_at).getTime() + c.duration_minutes * 60_000,
    })
  }
  return blocks
}

// Find where a weekly-availability run can show its label without being covered by
// same-day specific blocks or classes. Works in minutes clamped to the visible grid
// window; SLOT_HEIGHT is 30px per 30 min, so 1 minute = 1 pixel. The first gap of
// >= 56 min fits the two-line label, else the first gap of >= 28 min fits a single
// line, else the run renders unlabelled (the legend is the backstop).
function computeWashLabel(
  run: { startMin: number; endMin: number },
  overlays: Array<{ startMin: number; endMin: number }>
): { offsetMin: number; twoLine: boolean } | null {
  const visStart = Math.max(run.startMin, START_HOUR * 60)
  const visEnd = Math.min(run.endMin, END_HOUR * 60 + 30)

  const clamped = overlays
    .map(o => ({ start: Math.max(o.startMin, visStart), end: Math.min(o.endMin, visEnd) }))
    .filter(o => o.end > o.start)
    .sort((a, b) => a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  for (const o of clamped) {
    const last = merged[merged.length - 1]
    if (last && o.start <= last.end) {
      last.end = Math.max(last.end, o.end)
    } else {
      merged.push({ start: o.start, end: o.end })
    }
  }

  const gaps: Array<{ start: number; end: number }> = []
  let cursor = visStart
  for (const o of merged) {
    if (o.start > cursor) gaps.push({ start: cursor, end: o.start })
    cursor = o.end
  }
  if (cursor < visEnd) gaps.push({ start: cursor, end: visEnd })

  const twoLineGap = gaps.find(g => g.end - g.start >= 56)
  if (twoLineGap) return { offsetMin: twoLineGap.start - run.startMin, twoLine: true }
  const oneLineGap = gaps.find(g => g.end - g.start >= 28)
  if (oneLineGap) return { offsetMin: oneLineGap.start - run.startMin, twoLine: false }
  return null
}

export default function DayToDay({ profile, availability, onAvailabilityChange }: Props) {
  const supabase = createClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // The grid's single render frame. Falls back to UTC (with a visible banner
  // below) when profiles.timezone holds an invalid IANA value — the column is
  // unconstrained TEXT, and an unguarded Intl call would blank the whole tab.
  // Writes never use the fallback: the commit handler converts through
  // profile.timezone and fails closed with an error instead.
  const displayTz = useMemo(
    () => (isValidTimeZone(profile.timezone) ? profile.timezone : 'UTC'),
    [profile.timezone]
  )
  const tzInvalid = displayTz !== profile.timezone

  const [classes, setClasses] = useState<ClassEvent[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [mode, setMode] = useState<null | 'available' | 'unavailable'>(null)
  // Week of "today" in the PROFILE timezone, not the browser's — near midnight
  // the two can disagree by a day.
  const [weekStart, setWeekStart] = useState<Date>(() => getMondayWeekStart(tzTodayDate(displayTz)))
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [classDetail, setClassDetail] = useState<{
    studentName: string
    dayIdx: number
    startMin: number
    endMin: number
  } | null>(null)
  const [exportMsg, setExportMsg] = useState('')
  const [actionError, setActionError] = useState('')
  const [drag, setDrag] = useState<null | { dayIdx: number; startSlot: number; endSlot: number }>(null)
  const [now, setNow] = useState<Date>(() => new Date())
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week')
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const t = tzTodayDate(displayTz)
    return new Date(t.getFullYear(), t.getMonth(), 1)
  })
  const [monthClasses, setMonthClasses] = useState<ClassEvent[]>([])

  // Tracks the visible range without causing the Realtime subscription to re-subscribe
  // on every week navigation. The subscription callback reads this ref at event time
  // so it always fetches the week the user is currently viewing.
  const visibleRangeRef = useRef<{ start: string; end: string } | null>(null)

  // Esc clears mode (and any in-flight drag preview).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (classDetail) { setClassDetail(null); return }
        setMode(null)
        setDrag(null)
        isDraggingRef.current = false
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [classDetail])

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

  // Visible range as TRUE UTC instants: profile-tz Monday 00:00 up to (but not
  // including) next Monday 00:00. The old offset-less local strings were read
  // as UTC by PostgREST, silently shifting the fetch window by the tz offset
  // and dropping boundary classes for far-from-UTC teachers; the half-open end
  // (gte/lt) also kills the inclusive-lte duplicate of a class at exactly next
  // Monday midnight.
  const visibleRange = useMemo(() => ({
    start: new Date(localTimeToUtcMs(toLocalDateStr(weekStart), '00:00', displayTz)).toISOString(),
    end: new Date(localTimeToUtcMs(toLocalDateStr(addDays(weekStart, 7)), '00:00', displayTz)).toISOString(),
  }), [weekStart, displayTz])

  useEffect(() => {
    visibleRangeRef.current = visibleRange
  }, [visibleRange])

  // startStr/endStr are UTC ISO instants; the end bound is EXCLUSIVE (lt) so
  // adjacent windows never double-count a boundary class. The export path
  // passes no endStr and is unaffected.
  async function fetchClassesInRange(startStr: string, endStr?: string): Promise<ClassEvent[] | null> {
    let query = supabase
      .from('lessons')
      .select(`id, scheduled_at, duration_minutes, students ( full_name )`)
      .eq('teacher_id', profile.id)
      .gte('scheduled_at', startStr)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
    if (endStr !== undefined) query = query.lt('scheduled_at', endStr)
    const { data, error } = await query

    if (error) {
      console.error('[DayToDay fetchClassesInRange]', error)
      return null
    }
    if (!data) return []
    return data.map((c: any) => {
      const student = Array.isArray(c.students) ? c.students[0] : c.students
      return {
        id: c.id,
        scheduled_at: c.scheduled_at,
        duration_minutes: c.duration_minutes,
        student_name: student?.full_name ?? 'Unknown student',
      }
    })
  }

  async function fetchClassesForRange(startStr: string, endStr: string) {
    const data = await fetchClassesInRange(startStr, endStr)
    // null = query error: keep the previous week's state rather than blanking
    // the view on a transient failure.
    if (data !== null) setClasses(data)
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

  // Refetch on focus/visibility to heal the Realtime teacher-reassignment gap: when a
  // class is reassigned away from this teacher, the previous teacher's calendar gets no
  // postgres_changes event (its teacher_id no longer matches the subscription filter), so
  // the stale block lingers until a manual refresh. BOTH listeners are needed: switching
  // browser tabs fires visibilitychange but not window focus; alt-tabbing back to the
  // window fires focus. A double-fire double-fetch is harmless (idempotent GET).
  useEffect(() => {
    function handler() {
      const range = visibleRangeRef.current
      if (range) fetchClassesForRange(range.start, range.end)
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') handler()
    }
    window.addEventListener('focus', handler)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', handler)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart])

  const generalBlocks = useMemo(
    () => expandGeneralSlots(availability.filter(a => a.type === 'general'), weekStart),
    [availability, weekStart]
  )

  const greenBlocks = useMemo(
    () => expandSpecificBlocks(availability.filter(a => a.type === 'specific' && a.is_available), weekStart, displayTz),
    [availability, weekStart, displayTz]
  )

  const redBlocks = useMemo(
    () => expandSpecificBlocks(
      availability.filter(a => (a.type === 'specific' || a.type === 'holiday') && !a.is_available),
      weekStart,
      displayTz
    ),
    [availability, weekStart, displayTz]
  )

  const classBlocksList = useMemo(
    () => expandClassBlocks(classes, weekStart, displayTz),
    [classes, weekStart, displayTz]
  )

  // NEW282: earliest event minute (since local midnight) in the visible week — the smallest
  // start among booked classes and every availability/unavailability block. Holiday and
  // full-day unavailable blocks start at 00:00, so they pull the default scroll to the top of
  // the grid and keep their label in view. null when the week has nothing to show, so the
  // scroll effect below falls back to 08:00.
  const earliestEventMin = useMemo(() => {
    const starts = [
      ...classBlocksList.map(b => b.startMin),
      ...generalBlocks.map(b => b.startMin),
      ...greenBlocks.map(b => b.startMin),
      ...redBlocks.map(b => b.startMin),
    ]
    return starts.length > 0 ? Math.min(...starts) : null
  }, [classBlocksList, generalBlocks, greenBlocks, redBlocks])

  // NEW282: position the vertical scroll so the earliest event of the visible week — and any
  // holiday/unavailability label parked at the top of a day — is on screen at a glance. Target
  // one hour before the earliest start; pxFromMin clamps it into the START_HOUR..END_HOUR grid.
  // Falls back to 08:00 when the week is empty. Keyed on the fetched classes and the visible
  // week (not just viewMode), so it re-scrolls on week navigation, on re-entry into week view,
  // and after the async class fetch resolves — reading the freshest earliestEventMin each time.
  useEffect(() => {
    if (viewMode !== 'week' || !scrollRef.current) return
    const targetMin = earliestEventMin !== null ? earliestEventMin - 60 : 8 * 60
    scrollRef.current.scrollTop = pxFromMin(targetMin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, weekStart, classes])

  // Wash label placement per weekly run, keyed `${dayIdx}-${index within that day}` to
  // match the render-time filter order. dragPreview is deliberately not an input:
  // labels must not move mid-drag.
  const washLabels = useMemo(() => {
    const map = new Map<string, { offsetMin: number; twoLine: boolean }>()
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const overlays = [
        ...greenBlocks.filter(b => b.dayIdx === dayIdx),
        ...redBlocks.filter(b => b.dayIdx === dayIdx),
        ...classBlocksList.filter(b => b.dayIdx === dayIdx),
      ].map(b => ({ startMin: b.startMin, endMin: b.endMin }))
      generalBlocks
        .filter(b => b.dayIdx === dayIdx)
        .forEach((b, i) => {
          const label = computeWashLabel(b, overlays)
          if (label) map.set(`${dayIdx}-${i}`, label)
        })
    }
    return map
  }, [generalBlocks, greenBlocks, redBlocks, classBlocksList])

  // Profile-tz wall clock of the 60s `now` tick — drives the now-indicator, the
  // today column, and the month grid's today cell, all in the same frame as the
  // blocks. Re-derives each tick, so the today column rolls over at PROFILE-TZ
  // midnight rather than freezing on the mount-time value.
  const nowParts = useMemo(() => utcInstantToTzParts(now, displayTz), [now, displayTz])
  const todayHolder = useMemo(
    () => new Date(nowParts.year, nowParts.month - 1, nowParts.day),
    [nowParts]
  )

  // Today's column index, or -1 if today is outside the visible week.
  const todayIdx = useMemo(() => dayIndexInWeek(todayHolder, weekStart), [todayHolder, weekStart])

  // Month grid geometry: the Monday-first cell span covering monthAnchor's month.
  // weekCount is the exact number of week-rows (4-6) so no fully-adjacent-month row shows.
  const monthGrid = useMemo(() => {
    const year = monthAnchor.getFullYear()
    const month = monthAnchor.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const leadingBlanks = (monthAnchor.getDay() + 6) % 7   // Mon=0 offset of the 1st
    const weekCount = Math.ceil((leadingBlanks + daysInMonth) / 7)
    const gridStart = getMondayWeekStart(monthAnchor)
    const days = Array.from({ length: weekCount * 7 }, (_, i) => addDays(gridStart, i))
    return { gridStart, days }
  }, [monthAnchor])

  // Booked-class counts per PROFILE-TZ day (YYYY-MM-DD) for the month grid,
  // bucketed in the same frame the week view uses in expandClassBlocks; the
  // holder-keyed lookup in the cell render (toLocalDateStr(day)) emits the same
  // YYYY-MM-DD shape, so the two key spaces always line up.
  const monthClassCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of monthClasses) {
      const key = tzDateStr(c.scheduled_at, displayTz)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [monthClasses, displayTz])

  // Month-mode data: fetch the full visible grid span so leading/trailing cells show
  // truthful counts. Separate from the week fetch path, which stays unchanged.
  useEffect(() => {
    if (viewMode !== 'month') return
    const { gridStart, days } = monthGrid
    // Same UTC-instant window shape as visibleRange: [grid start 00:00, day
    // after grid end 00:00) in the profile timezone.
    const startStr = new Date(localTimeToUtcMs(toLocalDateStr(gridStart), '00:00', displayTz)).toISOString()
    const endStr = new Date(localTimeToUtcMs(toLocalDateStr(addDays(gridStart, days.length)), '00:00', displayTz)).toISOString()
    let cancelled = false
    fetchClassesInRange(startStr, endStr).then(data => { if (!cancelled && data !== null) setMonthClasses(data) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, monthGrid, displayTz])

  // True instant a slot starts: the column's profile-tz calendar date + the
  // slot's wall-clock label, converted through the display timezone (DST-exact
  // via localTimeToUtcMs). Never holder-midnight + minute maths — that instant
  // lives in the browser's frame, not the grid's. Max slot label is 23:30, so
  // the HH:MM form never reaches 24:00.
  function slotStartMs(dayIdx: number, slotIdx: number): number {
    const min = START_HOUR * 60 + slotIdx * 30
    return localTimeToUtcMs(toLocalDateStr(weekDays[dayIdx]), formatTime(min), displayTz)
  }

  function startDrag(dayIdx: number, slotIdx: number) {
    if (!mode) return
    if (slotStartMs(dayIdx, slotIdx) < Date.now()) return
    isDraggingRef.current = true
    setDrag({ dayIdx, startSlot: slotIdx, endSlot: slotIdx })
  }

  function extendDrag(dayIdx: number, slotIdx: number) {
    if (!isDraggingRef.current || !drag) return
    if (dayIdx !== drag.dayIdx) return
    if (slotStartMs(dayIdx, slotIdx) < Date.now()) return
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
      const dateStr = toLocalDateStr(date)  // profile-tz calendar date of the column
      const startMin = START_HOUR * 60 + lo * 30
      const endMin = START_HOUR * 60 + hi * 30
      const startStr = `${dateStr}T${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}:00`
      const endStr = `${dateStr}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`

      if (dateStr < toLocalDateStr(tzTodayDate(displayTz))) return

      setIsSaving(true)
      setActionError('')

      // The tz conversion throws (RangeError) on an invalid account timezone.
      // Fail closed with a visible error — never an unhandled rejection or a
      // stuck "Saving…" state. Deliberately profile.timezone rather than the
      // UTC display fallback: writing through a substitute frame would store
      // shifted instants.
      let startAtUtc: string
      let endAtUtc: string
      try {
        startAtUtc = localIsoToUtcIso(startStr, profile.timezone)
        endAtUtc = localIsoToUtcIso(endStr, profile.timezone)
      } catch {
        setActionError('Could not save — the timezone on this account is invalid. Please contact admin.')
        setIsSaving(false)
        return
      }

      try {
        const res = await fetch('/api/teacher/availability', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teacher_id: profile.id,
            type: 'specific',
            start_at: startAtUtc,
            end_at: endAtUtc,
            is_available: m === 'available',
          }),
        })
        if (res.ok) {
          const data = await res.json()
          // Functional update: a second drag committed while this await was in
          // flight must merge into the LATEST state — the spread-from-closure
          // form resurrected the pre-add array and silently dropped the first
          // block. Mirrors GeneralAvailability's pattern.
          if (data) onAvailabilityChange(prev => [...prev, data as AvailabilityRecord])
        } else {
          const body = await res.json().catch(() => ({}))
          setActionError(body.error ?? 'Failed to save. Please try again.')
        }
      } catch {
        // Network failure or malformed response body — surface it rather than
        // leaving an unhandled rejection behind.
        setActionError('Failed to save. Please try again.')
      } finally {
        setIsSaving(false)
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [drag, mode, weekDays, displayTz, profile.id, profile.timezone, onAvailabilityChange])

  async function confirmDelete() {
    if (!pendingDelete) return
    const id = pendingDelete
    try {
      const res = await fetch(`/api/teacher/availability/${id}`, { method: 'DELETE' })
      if (res.ok || res.status === 404) {
        // 404 = already gone server-side; removing locally is the correct end state.
        // Functional update: a save landing while this request was in flight must
        // not be resurrected by a stale closure over `availability` — same bug
        // shape as the add path above.
        onAvailabilityChange(prev => prev.filter(a => a.id !== id))
      } else {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error ?? 'Failed to remove block. Please try again.')
      }
    } catch {
      setActionError('Failed to remove block. Please try again.')
    } finally {
      setPendingDelete(null)
    }
  }

  async function exportClassesToCalendar() {
    try {
      const nowIso = new Date().toISOString()
      const upcoming = await fetchClassesInRange(nowIso)
      if (upcoming === null) {
        setExportMsg('Could not load classes — please try again')
        setTimeout(() => setExportMsg(''), 3000)
        return
      }
      if (upcoming.length === 0) {
        setExportMsg('No upcoming classes to export')
        setTimeout(() => setExportMsg(''), 3000)
        return
      }
      const stamp = toIcsDate(new Date().toISOString())
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//LinguaLink Online//Teacher Portal//EN',
      ]
      upcoming.forEach(c => {
        const endsAt = new Date(new Date(c.scheduled_at).getTime() + c.duration_minutes * 60_000).toISOString()
        lines.push(
          'BEGIN:VEVENT',
          `UID:${c.id}@lingualinkonline.com`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${toIcsDate(c.scheduled_at)}`,
          `DTEND:${toIcsDate(endsAt)}`,
          `SUMMARY:${escapeIcsText(c.student_name)}`,
          `DESCRIPTION:${escapeIcsText(`Class with ${c.student_name}`)}`,
          'END:VEVENT',
        )
      })
      lines.push('END:VCALENDAR')
      const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lingualink-classes-${toLocalDateStr(new Date())}.ics`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportMsg('Could not load classes — please try again')
      setTimeout(() => setExportMsg(''), 3000)
    }
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

  // Live warning when an unavailable drag overlaps booked classes. Derived from
  // dragPreview only; the commit handler is untouched and never blocks a save.
  // Half-open overlap test (strict <): a block ending 10:00 and a class starting 10:00
  // do not overlap. Clears automatically when dragPreview goes null (mouseup/Esc/mode).
  const dragClassOverlapCount = useMemo(() => {
    if (!dragPreview || mode !== 'unavailable') return 0
    return classBlocksList.filter(
      b => b.dayIdx === dragPreview.dayIdx && dragPreview.startMin < b.endMin && dragPreview.endMin > b.startMin
    ).length
  }, [dragPreview, mode, classBlocksList])

  // Now-indicator position from the PROFILE-TZ wall clock, matching the frame
  // the blocks render in.
  const nowMin = nowParts.hour * 60 + nowParts.minute
  const nowPx = (nowMin >= START_HOUR * 60 && nowMin <= END_HOUR * 60 + 30)
    ? pxFromMin(nowMin)
    : null

  // Profile-tz today (month-grid today treatment) and whether the month view is on
  // the current month (Today button disabled state in month mode). Same basis as todayIdx.
  const todayMid = todayHolder.getTime()
  const viewingCurrentMonth = monthAnchor.getFullYear() === todayHolder.getFullYear() && monthAnchor.getMonth() === todayHolder.getMonth()

  function gotoWeek(delta: number) {
    setDrag(null)
    isDraggingRef.current = false
    setWeekStart(addDays(weekStart, delta))
  }

  function goToToday() {
    setDrag(null)
    isDraggingRef.current = false
    setWeekStart(getMondayWeekStart(tzTodayDate(displayTz)))
  }

  function gotoMonth(delta: number) {
    setMonthAnchor(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + delta, 1))
  }

  function goToThisMonth() {
    const t = tzTodayDate(displayTz)
    setMonthAnchor(new Date(t.getFullYear(), t.getMonth(), 1))
  }

  // Week -> Month anchors to today's month when today falls inside the displayed week
  // [weekStart, weekStart + 7), else to weekStart's month (the user navigated elsewhere).
  // Computed fresh at click time so todayIdx memo staleness cannot bite. Guarded so
  // re-clicking Month while already in month mode does not re-anchor.
  function switchToMonth() {
    if (viewMode === 'month') return
    const today = tzTodayDate(displayTz)
    const todaySod = startOfDayLocal(today)
    const weekStartSod = startOfDayLocal(weekStart)
    const weekEndSod = startOfDayLocal(addDays(weekStart, 7))
    const anchorDate = (todaySod >= weekStartSod && todaySod < weekEndSod) ? today : weekStart
    setMonthAnchor(new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1))
    setViewMode('month')
  }

  function switchToWeek() {
    setViewMode('week')
  }

  // Clicking a month-grid day jumps to that day's week and returns to week view.
  function openWeekForDay(day: Date) {
    setDrag(null)
    isDraggingRef.current = false
    setWeekStart(getMondayWeekStart(day))
    setViewMode('week')
  }

  return (
    <div>
      {/* Sticky toolbar: rows 1 & 2 stick to the scrolling <main> */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB', paddingTop: '12px', paddingBottom: '12px', marginBottom: '12px' }}>
      {/* Row 1: mode buttons + hint */}
      {viewMode === 'week' && (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <button
          onClick={() => setMode(mode === 'available' ? null : 'available')}
          style={{
            backgroundColor: mode === 'available' ? '#16A34A' : '#F0FDF4',
            color: mode === 'available' ? '#ffffff' : '#15803D',
            border: mode === 'available' ? '1px solid #16A34A' : '1px solid #BBF7D0',
            borderRadius: '8px',
            padding: '6px 12px',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Availability
        </button>

        <button
          onClick={() => setMode(mode === 'unavailable' ? null : 'unavailable')}
          style={{
            backgroundColor: mode === 'unavailable' ? '#DC2626' : '#FEF2F2',
            color: mode === 'unavailable' ? '#ffffff' : '#B91C1C',
            border: mode === 'unavailable' ? '1px solid #DC2626' : '1px solid #FECACA',
            borderRadius: '8px',
            padding: '6px 12px',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Unavailability
        </button>

        {mode && (
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            {isSaving ? 'Saving…' : 'Drag to add blocks · Esc to exit'}
          </span>
        )}
      </div>
      )}

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

      {tzInvalid && (
        <p style={{ fontSize: '13px', color: '#92400E', marginBottom: '8px', padding: '8px 12px', backgroundColor: '#FFF6E6', borderRadius: '6px', border: '1px solid #FFB942' }}>
          The timezone on this account ({profile.timezone}) is not recognised — times are shown in UTC. Please contact admin to fix it before adding availability.
        </p>
      )}

      {dragClassOverlapCount > 0 && (
        <p style={{ fontSize: '13px', color: '#92400E', marginBottom: '8px', padding: '8px 12px', backgroundColor: '#FFF6E6', borderRadius: '6px', border: '1px solid #FFB942' }}>
          This selection overlaps {dragClassOverlapCount} booked class{dragClassOverlapCount === 1 ? '' : 'es'}. Booked classes are not cancelled by unavailability.
        </p>
      )}

      {/* Week navigation */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px' }}>
        <div style={{ flex: '1 1 0', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-start' }}>
          <button
            onClick={() => (viewMode === 'month' ? gotoMonth(-1) : gotoWeek(-7))}
            aria-label={viewMode === 'month' ? 'Previous month' : 'Previous week'}
            style={{ width: '34px', height: '34px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff', color: '#374151', fontSize: '15px', cursor: 'pointer' }}
          >
            ←
          </button>
        <button
          onClick={() => (viewMode === 'month' ? gotoMonth(1) : gotoWeek(7))}
          aria-label={viewMode === 'month' ? 'Next month' : 'Next week'}
          style={{ width: '34px', height: '34px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff', color: '#374151', fontSize: '15px', cursor: 'pointer' }}
        >
          →
        </button>
          <button
            onClick={viewMode === 'month' ? goToThisMonth : goToToday}
            disabled={viewMode === 'month' ? viewingCurrentMonth : todayIdx >= 0}
            style={{ padding: '7px 16px', borderRadius: '8px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff', color: '#374151', fontSize: '13px', fontWeight: 600, cursor: (viewMode === 'month' ? viewingCurrentMonth : todayIdx >= 0) ? 'default' : 'pointer', opacity: (viewMode === 'month' ? viewingCurrentMonth : todayIdx >= 0) ? 0.5 : 1 }}
          >
            Today
          </button>
          <div style={{ display: 'inline-flex', alignItems: 'center', padding: '2px', borderRadius: '999px', border: '1px solid #E5E7EB', backgroundColor: '#ffffff' }}>
            <button
              onClick={switchToWeek}
              style={{ padding: '6px 16px', borderRadius: '999px', border: 'none', backgroundColor: viewMode === 'week' ? '#FF8303' : 'transparent', color: viewMode === 'week' ? '#ffffff' : '#374151', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Week
            </button>
            <button
              onClick={switchToMonth}
              style={{ padding: '6px 16px', borderRadius: '999px', border: 'none', backgroundColor: viewMode === 'month' ? '#FF8303' : 'transparent', color: viewMode === 'month' ? '#ffffff' : '#374151', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Month
            </button>
          </div>
        </div>
        <span style={{ flex: 'none', fontSize: '16px', fontWeight: 600, color: '#111827' }}>{viewMode === 'month' ? `${MONTHS_LONG[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}` : formatWeekLabel(weekStart)}</span>
        {/* right side: legend (week only) then Export */}
        <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', gap: '14px', justifyContent: 'flex-end' }}>
          {viewMode === 'week' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              {[
                { color: '#FF8303', label: 'Booked' },
                { color: '#16A34A', label: 'Available' },
                { color: '#C9D4E2', label: 'Weekly' },
                { color: '#DC2626', label: 'Unavailable' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: item.color }} />
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>{item.label}</span>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={exportClassesToCalendar}
            title={`Exports all your upcoming classes as a calendar file. All times shown in ${displayTz}.`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '7px 14px',
              backgroundColor: '#ffffff',
              color: '#374151',
              border: '1px solid #E5E7EB',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </div>
      </div>

      {viewMode === 'week' && (
        <>
      {/* Calendar grid */}
      <div
        ref={scrollRef}
        className="thin-scroll"
        style={{
          background: '#ffffff',
          borderRadius: '8px',
          padding: '0',
          border: '1px solid #E0DFDC',
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
            borderBottom: '1px solid #E0DFDC',
            borderRight: '1px solid #F1F1F0',
            borderTopLeftRadius: '8px',
            minHeight: '66px',
          }} />

          {/* Sticky header — day cells */}
          {weekDays.map((d, i) => {
            const isHeaderToday = i === todayIdx
            return (
              <div key={`h-${i}`} style={{
                position: 'sticky', top: 0, zIndex: 10,
                backgroundColor: '#ffffff',
                boxShadow: isHeaderToday ? 'inset 0 -3px 0 #FF8303' : undefined,
                borderBottom: isHeaderToday ? undefined : '1px solid #E0DFDC',
                borderRight: '1px solid #F1F1F0',
                textAlign: 'center',
                padding: '8px 4px',
              }}>
                <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', color: isHeaderToday ? '#FF8303' : '#9CA3AF' }}>
                  {DAY_LABELS[i].toUpperCase()}
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700, lineHeight: 1.1, color: isHeaderToday ? '#FF8303' : '#111827' }}>
                  {d.getDate()}
                </div>
                <div style={{ fontSize: '11px', fontWeight: 500, color: isHeaderToday ? '#FF8303' : '#9CA3AF' }}>
                  {MONTHS_SHORT[d.getMonth()]}
                </div>
              </div>
            )
          })}

          {/* Time gutter */}
          <div style={{ gridRow: 2, gridColumn: 1, position: 'relative', height: GRID_HEIGHT, backgroundColor: '#ffffff', borderRight: '1px solid #F1F1F0' }}>
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
                  color: '#9CA3AF',
                  borderTop: onTheHour ? '1px solid #E9EAEC' : '1px solid #F4F5F6',
                }}>
                  {onTheHour ? formatHourLabel(Math.floor(min / 60)) : ''}
                </div>
              )
            })}
            {todayIdx >= 0 && nowPx !== null && (
              <div style={{
                position: 'absolute',
                top: nowPx - 8,
                right: '2px',
                fontSize: '10px',
                fontWeight: 700,
                color: '#FD5602',
                backgroundColor: '#ffffff',
                padding: '1px 4px',
                borderRadius: '4px',
                pointerEvents: 'none',
                zIndex: 6,
                whiteSpace: 'nowrap',
              }}>
                {formatTime(nowMin)}
              </div>
            )}
          </div>

          {/* Day columns */}
          {weekDays.map((_day, dayIdx) => {
            const isToday = dayIdx === todayIdx
            return (
              <div key={`d-${dayIdx}`} style={{
                gridRow: 2,
                gridColumn: dayIdx + 2,
                position: 'relative',
                height: GRID_HEIGHT,
                borderRight: '1px solid #F1F1F0',
                backgroundColor: isToday ? 'rgba(255, 131, 3, 0.045)' : 'transparent',
              }}>
                {/* Slot cells (38) - drag interaction */}
                {Array.from({ length: SLOT_COUNT }, (_, slotIdx) => {
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
                        borderTop: onTheHour ? '1px solid #E9EAEC' : '1px solid #F4F5F6',
                        backgroundColor: 'transparent',
                        zIndex: 0,
                      }}
                    />
                  )
                })}

                {/* Layer 0: weekly recurring wash (non-interactive) */}
                {generalBlocks.filter(b => b.dayIdx === dayIdx).map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  const label = washLabels.get(`${dayIdx}-${i}`)
                  const labelTop = label ? pxFromMin(b.startMin + label.offsetMin) - pxFromMin(b.startMin) : 0
                  return (
                    <div key={`g-${i}`} style={{
                      position: 'absolute',
                      top, left: 0, right: 0, height,
                      backgroundColor: '#EDF2F7',
                      border: '1px dashed #C9D4E2',
                      borderRadius: '8px',
                      pointerEvents: 'none',
                      zIndex: 1,
                    }}>
                      {label && (label.twoLine ? (
                        <div style={{ position: 'absolute', top: labelTop, left: 0, right: 0, padding: '5px 7px', overflow: 'hidden' }}>
                          <div style={{ fontSize: '11.5px', fontWeight: 500, color: '#475569', lineHeight: 1.2 }}>{timeRangeLabel(b.startMin, b.endMin)}</div>
                          <div style={{ fontSize: '11px', color: '#64748B', lineHeight: 1.3, marginTop: '2px' }}>Weekly availability</div>
                        </div>
                      ) : (
                        <div style={{ position: 'absolute', top: labelTop, left: 0, right: 0, padding: '5px 7px', overflow: 'hidden', fontSize: '11.5px', fontWeight: 500, color: '#475569', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                          {timeRangeLabel(b.startMin, b.endMin)}
                        </div>
                      ))}
                    </div>
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
                        backgroundColor: '#F0FDF4',
                        border: '1px solid #BBF7D0',
                        borderLeft: '3px solid #16A34A',
                        borderRadius: '8px',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                        padding: '3px 6px',
                        cursor: 'pointer',
                        zIndex: 2,
                        overflow: 'hidden',
                      }}
                    >
                      {height >= 44 ? (
                        <>
                          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                            <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#374151' }}>Available</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#6B7280' }}>{timeRangeLabel(b.startMin, b.endMin)}</div>
                          {height >= 68 && (
                            <div style={{ fontSize: '10.5px', color: '#9CA3AF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Available for bookings</div>
                          )}
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: '#4B5563', whiteSpace: 'nowrap' }}>{timeRangeLabel(b.startMin, b.endMin)}</span>
                        </div>
                      )}
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
                        backgroundColor: '#FEF2F2',
                        border: '1px solid #FECACA',
                        borderLeft: '3px solid #DC2626',
                        borderRadius: '8px',
                        padding: '3px 6px',
                        cursor: 'pointer',
                        zIndex: 2,
                        overflow: 'hidden',
                      }}
                    >
                      {height >= 44 ? (
                        <>
                          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                            <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#B91C1C' }}>Unavailable</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#B91C1C' }}>{timeRangeLabel(b.startMin, b.endMin)}</div>
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: '#B91C1C', whiteSpace: 'nowrap' }}>{timeRangeLabel(b.startMin, b.endMin)}</span>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Layer 2: booked classes (orange, not deletable here) */}
                {classBlocksList.filter(b => b.dayIdx === dayIdx).map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  // Past classes mute to grey - true end instant compared to the
                  // 60s now tick. Instant vs instant: frame-free, so it needs no
                  // tz conversion (the old holder-midnight + minutes sum mixed
                  // the browser frame into profile-tz minutes).
                  const isPastClass = b.endMs < now.getTime()
                  return (
                    <div key={`cl-${i}`} title={b.studentName} onClick={() => setClassDetail({ studentName: b.studentName, dayIdx: b.dayIdx, startMin: b.startMin, endMin: b.endMin })} style={{
                      position: 'absolute',
                      top, left: '2px', right: '2px', height,
                      backgroundColor: isPastClass ? '#F9FAFB' : '#FFF3E0',
                      border: isPastClass ? '1px solid #E5E7EB' : '1px solid #FFD9A8',
                      borderLeft: isPastClass ? '3px solid #D6D3CE' : '3px solid #FF8303',
                      borderRadius: '8px',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                      padding: '3px 6px',
                      cursor: 'pointer',
                      zIndex: 3,
                      overflow: 'hidden',
                    }}>
                      {height >= 44 ? (
                        <>
                          <div style={{ fontSize: '11.5px', fontWeight: 600, color: isPastClass ? '#9CA3AF' : '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.studentName}</div>
                          <div style={{ fontSize: '11px', color: isPastClass ? '#9CA3AF' : '#4B5563' }}>{timeRangeLabel(b.startMin, b.endMin)}</div>
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <span style={{ fontSize: '10.5px', fontWeight: 600, color: isPastClass ? '#9CA3AF' : '#111827', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>{b.studentName}</span>
                          <span style={{ fontSize: '10.5px', color: isPastClass ? '#9CA3AF' : '#4B5563', whiteSpace: 'nowrap', flexShrink: 0 }}>{timeRangeLabel(b.startMin, b.endMin)}</span>
                        </div>
                      )}
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
                    background: mode === 'available'
                      ? 'rgba(220,252,231,0.85)'
                      : 'repeating-linear-gradient(45deg, rgba(220,38,38,0.16) 0 6px, rgba(220,38,38,0.04) 6px 12px)',
                    border: `1px dashed ${mode === 'available' ? '#16A34A' : '#DC2626'}`,
                    borderRadius: '8px',
                    pointerEvents: 'none',
                    zIndex: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: mode === 'available' ? '#15803D' : '#B91C1C',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}>
                    {timeRangeLabel(dragPreview.startMin, dragPreview.endMin)}
                  </div>
                )}

                {/* Now indicator (today only) - line plus a dot on its left end */}
                {isToday && nowPx !== null && (
                  <>
                    <div style={{
                      position: 'absolute',
                      top: nowPx - 1,
                      left: 0, right: 0,
                      height: '2px',
                      backgroundColor: '#FD5602',
                      pointerEvents: 'none',
                      zIndex: 5,
                    }} />
                    <div style={{
                      position: 'absolute',
                      top: nowPx - 4,
                      left: '-4px',
                      width: '8px', height: '8px',
                      borderRadius: '50%',
                      backgroundColor: '#FD5602',
                      pointerEvents: 'none',
                      zIndex: 5,
                    }} />
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <p style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '12px' }}>
        Click any green or red block to remove it. Booked classes cannot be removed here.
      </p>
        </>
      )}

      {viewMode === 'month' && (
        <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #E0DFDC', overflow: 'hidden' }}>
          {/* Weekday header row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
            {DAY_LABELS.map((label, i) => (
              <div key={`mh-${i}`} style={{
                textAlign: 'center',
                padding: '8px 4px',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: '#9CA3AF',
                backgroundColor: '#ffffff',
                borderBottom: '1px solid #E0DFDC',
                borderRight: i < 6 ? '1px solid #F1F1F0' : undefined,
              }}>
                {label.toUpperCase()}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
            {monthGrid.days.map((day, i) => {
              const inMonth = day.getMonth() === monthAnchor.getMonth()
              const isToday = startOfDayLocal(day) === todayMid
              const count = monthClassCounts.get(toLocalDateStr(day)) ?? 0
              const col = i % 7
              const row = Math.floor(i / 7)
              return (
                <div
                  key={`mc-${i}`}
                  onClick={() => openWeekForDay(day)}
                  style={{
                    minHeight: '84px',
                    padding: '6px 7px',
                    cursor: 'pointer',
                    backgroundColor: isToday ? 'rgba(255, 131, 3, 0.06)' : '#ffffff',
                    borderTop: row > 0 ? '1px solid #F1F1F0' : undefined,
                    borderRight: col < 6 ? '1px solid #F1F1F0' : undefined,
                  }}
                >
                  <div style={{
                    fontSize: '13px',
                    fontWeight: isToday ? 700 : 600,
                    color: isToday ? '#FF8303' : (inMonth ? '#111827' : '#C7CBD1'),
                  }}>
                    {day.getDate()}
                  </div>
                  {count > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '1px 7px',
                        borderRadius: '999px',
                        backgroundColor: '#FF8303',
                        color: '#ffffff',
                        fontSize: '10.5px',
                        fontWeight: 600,
                      }}>
                        {count} {count === 1 ? 'class' : 'classes'}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

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

      {classDetail && (
        <div
          onClick={() => setClassDetail(null)}
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: '320px', maxWidth: '360px',
            }}
          >
            <p style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '12px' }}>
              {classDetail.studentName}
            </p>
            <p style={{ fontSize: '13px', color: '#374151', marginBottom: '6px' }}>
              {weekDays[classDetail.dayIdx].toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            <p style={{ fontSize: '13px', color: '#374151', marginBottom: '6px' }}>
              {timeRangeLabel(classDetail.startMin, classDetail.endMin)}
            </p>
            <p style={{ fontSize: '13px', color: '#6B7280', marginBottom: '20px' }}>
              {classDetail.endMin - classDetail.startMin} minutes
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setClassDetail(null)}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: '1px solid #D1D5DB',
                  backgroundColor: '#F3F4F6', color: '#374151', fontSize: '13px',
                  fontWeight: '600', cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
