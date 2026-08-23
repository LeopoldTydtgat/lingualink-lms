'use client'

import { useState, useEffect, useRef, useMemo, Dispatch, SetStateAction, type MouseEvent as ReactMouseEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import { localTimeToUtcMs } from '@/lib/availability'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { getMondayWeekStart, addDays, getWeekDays, formatWeekLabel } from '@/lib/utils/week'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'
import { buildIcsCalendar } from '@/lib/ics'
import { Download, Lock } from 'lucide-react'
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
const START_HOUR = 0
const END_HOUR = 23
const SLOT_COUNT = 48                              // 00:00 → 24:00 in 30-min slots
const GRID_HEIGHT = SLOT_COUNT * SLOT_HEIGHT       // 1440px
// Monday-first; index-aligned with getWeekDays(weekStart) — DAY_LABELS[i] labels weekDays[i].
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function pad(n: number): string {
  return String(n).padStart(2, '0')
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

// Rows the Google busy-sync owns. Google Calendar is the source of truth for
// them: they are labelled and read-only in the portal, and the DELETE route
// refuses them outright. Everything else is manual and unchanged.
const GOOGLE_SOURCE = 'google_sync'

// Positive test only. An absent/unknown source is treated as manual, which is
// correct for the one case that produces it: a row appended optimistically from
// the POST response, which does not return the column and is manual by
// construction. The server-side guard, not this branch, is the enforcement.
function isGoogleBlock(source: string | null | undefined): boolean {
  return source === GOOGLE_SOURCE
}

interface SpecificBlock {
  dayIdx: number
  startMin: number
  endMin: number
  recordId: string
  source: string | null
  // Row type of the record this block came from. The red layer mixes timed
  // 'specific' rows with whole-day 'holiday' ones and only the former may be
  // selected, moved or resized, so the type has to travel with the block -
  // the renderer must not have to re-read the availability array to tell them
  // apart.
  recordType: string
  // The record's TRUE start instant, straight off start_at. Past-ness is an
  // instant comparison and needs no timezone, so it never goes through the
  // grid's minute frame.
  startMs: number
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
          blocks.push({ dayIdx, startMin: 0, endMin: 24 * 60, recordId: r.id, source: r.source ?? null, recordType: r.type, startMs: Date.parse(r.start_at) })
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
    blocks.push({ dayIdx, startMin, endMin, recordId: r.id, source: r.source ?? null, recordType: r.type, startMs: Date.parse(r.start_at) })
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

// A visible piece of a green/red availability run after same-day booked-class
// intervals are subtracted from it. Edges at the run's true start/end keep
// their 8px rounded corner; edges created by a booking cut render square.
// runStartMin/runEndMin carry the record's full range for the label, and
// labelHost marks the largest segment of its run - the label renders there so
// it never sits under a booking.
interface BlockSegment {
  recordId: string
  // Carried from the source record so the red layer can branch on it without
  // re-reading the availability array.
  source: string | null
  // Same purpose, for the two properties the move/resize gesture gates on: the
  // record's type ('specific' is editable, 'holiday' is not) and its true start
  // instant (a block that has already started may be deleted but not moved).
  recordType: string
  startMs: number
  dayIdx: number
  startMin: number
  endMin: number
  runStartMin: number
  runEndMin: number
  roundTop: boolean
  roundBottom: boolean
  labelHost: boolean
}

// Subtract booked-class intervals from an availability run, yielding its
// visible segments. Same clamp-merge-gap walk as computeWashLabel above.
// Slivers under 4 min (~4px at 1px/min) are dropped. An empty result means
// the booking(s) cover the whole run - the class card is the whole visual.
function subtractClassIntervals(
  run: SpecificBlock,
  dayClasses: Array<{ startMin: number; endMin: number }>
): BlockSegment[] {
  const clamped = dayClasses
    .map(c => ({ start: Math.max(c.startMin, run.startMin), end: Math.min(c.endMin, run.endMin) }))
    .filter(c => c.end > c.start)
    .sort((a, b) => a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  for (const c of clamped) {
    const last = merged[merged.length - 1]
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end)
    } else {
      merged.push({ start: c.start, end: c.end })
    }
  }

  const gaps: Array<{ start: number; end: number }> = []
  let cursor = run.startMin
  for (const c of merged) {
    if (c.start > cursor) gaps.push({ start: cursor, end: c.start })
    cursor = c.end
  }
  if (cursor < run.endMin) gaps.push({ start: cursor, end: run.endMin })

  const segments = gaps
    .filter(g => g.end - g.start >= 4)
    .map(g => ({
      recordId: run.recordId,
      source: run.source,
      recordType: run.recordType,
      startMs: run.startMs,
      dayIdx: run.dayIdx,
      startMin: g.start,
      endMin: g.end,
      runStartMin: run.startMin,
      runEndMin: run.endMin,
      roundTop: g.start === run.startMin,
      roundBottom: g.end === run.endMin,
      labelHost: false,
    }))

  if (segments.length > 0) {
    let largest = segments[0]
    for (const s of segments) {
      if (s.endMin - s.startMin > largest.endMin - largest.startMin) largest = s
    }
    largest.labelHost = true
  }
  return segments
}

// Corner rule per segment: true-run edges stay rounded, booking cuts are square.
function segmentRadius(s: BlockSegment): string {
  if (s.roundTop && s.roundBottom) return '8px'
  if (s.roundTop) return '8px 8px 0 0'
  if (s.roundBottom) return '0 0 8px 8px'
  return '0'
}

// THE SINGLE GATE for select / move / resize. A block is editable only when it
// is a MANUAL, timed 'specific' row:
//   - google_sync rows belong to Google Calendar. Both the DELETE and the PATCH
//     route refuse them outright, and the busy-sync cron replaces its own
//     generation every run, so a move here would be undone within the quarter
//     hour. They keep exactly the click they have today (the explainer modal).
//   - 'holiday' rows are spans of calendar DATES painted as full columns; a
//     30-minute nudge is meaningless for one, PATCH rejects them with a 400,
//     and they are edited from the Holidays tab. They keep exactly the click
//     they have today (straight to the delete confirmation).
// Every gesture entry point and every affordance runs through this one test.
function isEditableBlock(b: { source: string | null; recordType: string }): boolean {
  return !isGoogleBlock(b.source) && b.recordType === 'specific'
}

// Minutes in a grid day. Equal to GRID_HEIGHT because the grid renders at
// exactly 1px per minute (SLOT_HEIGHT 30px per 30 min), but the two are
// different units and the move/resize clamps are minute maths, not pixels.
const DAY_MINUTES = SLOT_COUNT * 30

type BlockDragKind = 'move' | 'resize-top' | 'resize-bottom'

interface BlockDragState {
  kind: BlockDragKind
  recordId: string
  // Polarity of the record being dragged, so the ghost can borrow the same
  // green/red visual language the drag-create preview uses without looking the
  // record back up mid-gesture.
  isAvailable: boolean
  // The record's FULL range when the gesture began - never a segment's. A run
  // split by a booked class renders as several segments sharing one recordId,
  // and dragging any of them moves the whole record.
  originDayIdx: number
  originStartMin: number
  originEndMin: number
  // Where the pointer was on the grid at mousedown. A move tracks the delta
  // from this point, so the block keeps the grab offset instead of snapping its
  // top edge to the cursor.
  grabDayIdx: number
  grabMin: number
  // Live snapped preview.
  dayIdx: number
  startMin: number
  endMin: number
  // False until the preview actually leaves the origin. A block picked up and
  // dropped in place sends nothing.
  changed: boolean
}

// The response body POST and PATCH /api/teacher/availability both return for a
// timed 'specific' write: the row that was written, the ids the server
// reconciled away, and the trimmed remainders it wrote back for the parts of
// those rows that survived. For a PATCH, removed_ids ALSO carries the moved
// row's own former id - the server implements a move as supersede/insert/delete
// rather than an UPDATE, so the block comes back with a new id.
//
// Older deploys - and POST's general/holiday branch, which this component never
// posts to - answer with the bare row instead. Detected on the presence of a
// `data` key, which no availability row carries; that shape degrades to exactly
// the pre-envelope behaviour, appending the one returned row and removing
// nothing.
//
// ONE functional update for the whole envelope: a single pass over prev drops
// the reconciled ids, then the remainders and the new row are appended.
// filter() already returns a fresh array, so the pushes never mutate prev. The
// functional form is load-bearing - a second write committed while this one's
// await was in flight must merge into the LATEST state; the spread-from-closure
// form resurrected the pre-write array and silently dropped the first block.
//
// Returns the written row (null when the payload carried none) so a caller can
// follow it: after a move the selection has to hop to the new id.
function applyAvailabilityEnvelope(
  payload: unknown,
  onAvailabilityChange: Dispatch<SetStateAction<AvailabilityRecord[]>>
): AvailabilityRecord | null {
  const envelope =
    payload !== null && typeof payload === 'object' && 'data' in payload
      ? (payload as { data?: AvailabilityRecord | null; removed_ids?: unknown; added?: unknown })
      : null

  const created = (envelope ? envelope.data : (payload as AvailabilityRecord | null)) ?? null
  const removedIds: string[] = envelope && Array.isArray(envelope.removed_ids) ? envelope.removed_ids : []
  const added: AvailabilityRecord[] = envelope && Array.isArray(envelope.added) ? envelope.added : []

  if (!created && removedIds.length === 0 && added.length === 0) return null

  const removed = new Set(removedIds)
  onAvailabilityChange(prev => {
    const next = prev.filter(a => !removed.has(a.id))
    if (added.length > 0) next.push(...added)
    if (created) next.push(created)
    return next
  })
  return created
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
  const [isDeleting, setIsDeleting] = useState(false)
  // Google-synced blocks open this explainer instead of the delete confirmation.
  // Deliberately a boolean, not a record id: there is nothing to act on.
  const [googleBlockInfo, setGoogleBlockInfo] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [classDetail, setClassDetail] = useState<{
    studentName: string
    dayIdx: number
    startMin: number
    endMin: number
  } | null>(null)
  const [exportMsg, setExportMsg] = useState('')
  const [actionError, setActionError] = useState('')
  const [drag, setDrag] = useState<null | { dayIdx: number; startSlot: number; endSlot: number }>(null)
  // ─── Select / move / resize an existing manual 'specific' block ─────────────
  // Selection is the gate for every edit gesture: a block must be selected
  // before it can be dragged, which is what keeps a mousedown on a block
  // unambiguous against the drag-create gesture on empty cells.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  // The record whose PATCH is in flight. Doubles as the pending affordance and
  // as the "ignore further gestures" latch - one availability write at a time.
  const [movingRecordId, setMovingRecordId] = useState<string | null>(null)
  // Live gesture. Mirrored into a ref because the window mousemove/mouseup
  // handlers are attached ONCE per gesture (re-attaching them on every snap
  // step would be pure churn) and must therefore read the current value rather
  // than a mount-time closure. The state copy exists only so the ghost renders.
  const [blockDrag, setBlockDrag] = useState<BlockDragState | null>(null)
  const blockDragRef = useRef<BlockDragState | null>(null)
  // One element per day column, filled by callback refs below. Read live at
  // pointer time so the mapping stays correct while the grid is scrolled, and
  // so nothing has to assume the grid template.
  const dayColRefs = useRef<Array<HTMLDivElement | null>>([])
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

  // Drop the selection and abandon any in-progress move/resize preview without
  // writing anything. Called from Esc and from every navigation that changes
  // which days are on screen - a selection that survived a week change would
  // point at a block the teacher can no longer see.
  function clearBlockSelection() {
    blockDragRef.current = null
    setBlockDrag(null)
    setSelectedRecordId(null)
  }

  // Esc clears mode (and any in-flight drag preview).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (googleBlockInfo) { setGoogleBlockInfo(false); return }
        if (classDetail) { setClassDetail(null); return }
        blockDragRef.current = null
        setBlockDrag(null)
        setSelectedRecordId(null)
        setMode(null)
        setDrag(null)
        isDraggingRef.current = false
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [classDetail, googleBlockInfo])

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

  // Mirrors isSaving / isDeleting / drag for refreshAvailability below. The
  // focus effect has [] deps, so reading those state values directly inside it
  // would close over their mount-time values forever and the guard would never
  // fire - only a ref reports the current ones.
  const availabilityBusyRef = useRef(false)
  useEffect(() => {
    // movingRecordId / blockDrag ride the same latch as the create path: a
    // focus refresh landing mid-move would overwrite the array with rows that
    // predate the PATCH.
    availabilityBusyRef.current =
      isSaving || isDeleting || drag !== null || movingRecordId !== null || blockDrag !== null
  }, [isSaving, isDeleting, drag, movingRecordId, blockDrag])

  // Generation counter: a response is dropped once a newer refresh has started,
  // so two focus events in quick succession cannot land out of order.
  const availabilityGenRef = useRef(0)

  // Mirrors the availability prop's length for the empty-read guard below, for
  // the same reason as availabilityBusyRef: the focus effect has [] deps, so
  // reading availability.length directly inside refreshAvailability would
  // close over its mount-time value forever.
  const availabilityLengthRef = useRef(availability.length)
  useEffect(() => {
    availabilityLengthRef.current = availability.length
  }, [availability])

  // The Google busy-sync cron writes availability rows every 15 minutes, but the
  // array is seeded into state at mount only - an open page would never see them
  // (the modal below promises otherwise). Re-read this teacher's rows on focus.
  // Not range-scoped: general rows carry no instant, and the same array feeds the
  // other two tabs, so it is always fetched and replaced whole. Column list is
  // the server fetch's, verbatim - dropping `source` would strip the Google lock
  // and route those rows into the delete-confirm dialog.
  async function refreshAvailability() {
    if (availabilityBusyRef.current || isDraggingRef.current) return
    const gen = ++availabilityGenRef.current

    const { data, error } = await supabase
      .from('availability')
      .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available, source')
      .eq('teacher_id', profile.id)
      .order('start_at', { ascending: true })

    // Same contract as fetchClassesForRange: a transient failure keeps the
    // previous state rather than blanking the calendar.
    if (error) {
      console.error('[DayToDay refreshAvailability]', error)
      return
    }
    if (!data) return
    // Re-checked AFTER the await: a drag, save or delete that began while the
    // read was in flight owns the array now, and these rows predate it.
    if (availabilityBusyRef.current || isDraggingRef.current) return
    if (gen !== availabilityGenRef.current) return

    // Fail safe: never blank a populated calendar on an unexplained empty
    // read. A zero-row response is indistinguishable from a genuinely
    // narrowed RLS policy (the admin mirror depends on availability's ALL
    // policy is_admin() clause) - Postgres returns [] for that, not an
    // error, so the guard above never fires. A teacher who really deleted
    // every row still sees the correct empty state on their next page load.
    if (data.length === 0 && availabilityLengthRef.current > 0) {
      console.warn('[DayToDay refreshAvailability] fetched 0 rows while local state has rows, suppressing to avoid blanking a live calendar')
      return
    }

    onAvailabilityChange(data as AvailabilityRecord[])
  }

  // Refetch classes when the visible week changes.
  useEffect(() => {
    fetchClassesForRange(visibleRange.start, visibleRange.end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRange.start, visibleRange.end])

  // Realtime: any change to this teacher's lessons re-fetches the visible week.
  // profile.id is stable for the component's lifetime so this runs once.
  useEffect(() => {
    let disposed = false
    let activeChannel: ReturnType<typeof supabase.channel> | null = null

    const establish = async () => {
      // Await auth so the shared realtime socket JWT is seeded before
      // subscribe() - anon-role subscriptions fail filter validation (P0001).
      let uid: string | null = null
      try {
        const { data, error } = await supabase.auth.getUser()
        if (!error) uid = data.user?.id ?? null
      } catch {
        // Network/auth failure — treated exactly like a null user below.
        uid = null
      }
      if (!uid) return
      if (disposed) return

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

      activeChannel = channel
    }

    void establish()

    return () => {
      disposed = true
      if (activeChannel) supabase.removeChannel(activeChannel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  // Refetch on focus/visibility to heal the Realtime teacher-reassignment gap: when a
  // class is reassigned away from this teacher, the previous teacher's calendar gets no
  // postgres_changes event (its teacher_id no longer matches the subscription filter), so
  // the stale block lingers until a manual refresh. BOTH listeners are needed: switching
  // browser tabs fires visibilitychange but not window focus; alt-tabbing back to the
  // window fires focus. A double-fire double-fetch is harmless (idempotent GET).
  // Availability rides the same two listeners: nothing pushes the cron's rows to
  // an open page, so focus is the moment to re-read them.
  useEffect(() => {
    function handler() {
      const range = visibleRangeRef.current
      if (range) fetchClassesForRange(range.start, range.end)
      void refreshAvailability()
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

  // Booked classes visually punch through availability: subtract each day's
  // class intervals from every green/red run and render only the remaining
  // segments. greenBlocks/redBlocks themselves stay untouched - washLabels
  // and earliestEventMin keep reading the full runs.
  const availabilitySegments = useMemo(() => {
    const split = (blocks: SpecificBlock[]): BlockSegment[] =>
      blocks.flatMap(b =>
        subtractClassIntervals(b, classBlocksList.filter(c => c.dayIdx === b.dayIdx))
      )
    return { green: split(greenBlocks), red: split(redBlocks) }
  }, [greenBlocks, redBlocks, classBlocksList])

  // Drives the footer's extra line only. Keyed off the visible week's red
  // segments, so the hint appears exactly when a locked block is on screen.
  const hasGoogleBlock = useMemo(
    () => availabilitySegments.red.some(b => isGoogleBlock(b.source)),
    [availabilitySegments]
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
  // one hour before the earliest start, with 00:00 as the natural minimum (pxFromMin's clamp is defensive-only).
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
    // Mousedown on an empty cell is "click elsewhere": it drops any selection.
    // Placed before the mode guard so it also fires with no mode armed, and
    // before every other line so the drag-create path below is untouched - a
    // selection is never live while a create drag runs.
    setSelectedRecordId(null)
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

      // Reachable only when the clock crosses profile-tz midnight mid-drag:
      // the column started on is now yesterday. startDrag/extendDrag already
      // reject past slots, so no other path arrives here. setDrag(null) above
      // has cleared the preview - without a message the selection would just
      // vanish with no explanation. isSaving was never set true on this path.
      if (dateStr < toLocalDateStr(tzTodayDate(displayTz))) {
        setActionError('That day is now in the past. The date changed while you were dragging, so the block was not saved. Please try again.')
        return
      }

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
          // Both response shapes handled in one place, shared with the
          // move/resize commit below - see applyAvailabilityEnvelope. Behaviour
          // for the bare-row shape is unchanged: append the one returned row,
          // remove nothing, and skip the update entirely on an empty payload.
          applyAvailabilityEnvelope(await res.json(), onAvailabilityChange)
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

  // ─── Move / resize an existing manual 'specific' block ──────────────────────

  // Map a viewport point onto the grid: the day column under it and the nearest
  // 30-minute mark. Rects are read live, so the mapping stays correct while the
  // grid is scrolled and nothing has to assume the grid template. All seven
  // columns share one grid row, so any mounted column supplies the vertical
  // origin. Math.round (not floor) snaps at the half-way point of each half
  // hour, which is what makes the drag feel like it follows the cursor.
  function pointToGrid(clientX: number, clientY: number): { dayIdx: number; min: number } | null {
    const rects = dayColRefs.current.map(el => (el ? el.getBoundingClientRect() : null))
    const anchor = rects.find((r): r is DOMRect => r !== null)
    if (!anchor) return null
    let dayIdx = rects.findIndex(r => r !== null && clientX >= r.left && clientX < r.right)
    // Sideways out of the grid (into the time gutter, or past Sunday): clamp to
    // the nearest column so the gesture keeps tracking instead of freezing.
    if (dayIdx === -1) dayIdx = clientX < anchor.left ? 0 : 6
    return { dayIdx, min: Math.round((clientY - anchor.top) / SLOT_HEIGHT) * 30 }
  }

  // Start a move or a resize. Every test below is a hard gate, not just an
  // affordance: isEditableBlock keeps google_sync and holiday rows out
  // entirely, the selection test makes a block draggable only after it has been
  // clicked once (which is what keeps this unambiguous against drag-create),
  // movingRecordId serialises writes, and startMs refuses a block that has
  // already begun - the PATCH route answers that with a 400.
  function beginBlockGesture(
    e: ReactMouseEvent<HTMLDivElement>,
    kind: BlockDragKind,
    b: BlockSegment,
    isAvailable: boolean
  ) {
    if (!isEditableBlock(b)) return
    if (selectedRecordId !== b.recordId) return
    if (movingRecordId !== null) return
    if (b.startMs < Date.now()) return
    const pt = pointToGrid(e.clientX, e.clientY)
    if (!pt) return
    // Suppress the native text-drag/selection this gesture would otherwise
    // start, and keep a resize-handle mousedown from also reading as a move.
    e.preventDefault()
    e.stopPropagation()
    setActionError('')
    // runStartMin/runEndMin, never the segment's own bounds: a run split by a
    // booked class renders as several segments sharing one recordId, and
    // dragging any one of them moves the whole record.
    const next: BlockDragState = {
      kind,
      recordId: b.recordId,
      isAvailable,
      originDayIdx: b.dayIdx,
      originStartMin: b.runStartMin,
      originEndMin: b.runEndMin,
      grabDayIdx: pt.dayIdx,
      grabMin: pt.min,
      dayIdx: b.dayIdx,
      startMin: b.runStartMin,
      endMin: b.runEndMin,
      changed: false,
    }
    blockDragRef.current = next
    setBlockDrag(next)
  }

  // PATCH the new range. Deliberately the SAME local->UTC path the create
  // commit uses: the TARGET column's profile-tz calendar date plus the snapped
  // wall-clock minutes, converted by localIsoToUtcIso through profile.timezone.
  // Never toISOString on a local Date, and never the UTC display fallback -
  // writing through a substitute frame would store shifted instants.
  async function commitBlockDrag(g: BlockDragState) {
    const dateStr = toLocalDateStr(weekDays[g.dayIdx])
    const startStr = `${dateStr}T${pad(Math.floor(g.startMin / 60))}:${pad(g.startMin % 60)}:00`
    const endStr = `${dateStr}T${pad(Math.floor(g.endMin / 60))}:${pad(g.endMin % 60)}:00`

    let startAtUtc: string
    let endAtUtc: string
    try {
      startAtUtc = localIsoToUtcIso(startStr, profile.timezone)
      endAtUtc = localIsoToUtcIso(endStr, profile.timezone)
    } catch {
      setActionError('Could not save - the timezone on this account is invalid. Please contact admin.')
      return
    }

    // Past guard, client side: the same rule startDrag applies to a create. A
    // block dragged onto an earlier day is the case that reaches here. The
    // server enforces it too (PATCH answers 400), so this exists to keep the
    // request from being sent at all, not as the only gate.
    if (Date.parse(startAtUtc) < Date.now()) {
      setActionError('That would move the block into the past, so it was not saved.')
      return
    }

    setMovingRecordId(g.recordId)
    try {
      const res = await fetch(`/api/teacher/availability/${g.recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_at: startAtUtc, end_at: endAtUtc }),
      })
      if (res.ok) {
        // removed_ids carries the block's own former id, so the one functional
        // update drops the old position and appends the new one together.
        const written = applyAvailabilityEnvelope(await res.json(), onAvailabilityChange)
        // A move is supersede + insert + delete server side, so the block comes
        // back under a NEW id. Carry the selection across rather than leaving it
        // pointing at a row that no longer exists.
        if (written) setSelectedRecordId(written.id)
      } else {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error ?? 'Failed to move the block. Please try again.')
      }
    } catch {
      setActionError('Failed to move the block. Please try again.')
    } finally {
      setMovingRecordId(null)
    }
  }

  // Window-level move/up for the block gesture. Attached ONCE per gesture - the
  // dep is the active flag alone - so a snap step does not re-register
  // listeners; the handlers read blockDragRef for the live value instead of
  // closing over state. Nothing else they close over can change mid-gesture:
  // the mouse is down, so no week navigation or timezone change can land. That
  // is why exhaustive-deps is suppressed rather than satisfied here - listing
  // weekDays/profile would re-attach on every render for no gain.
  const blockDragActive = blockDrag !== null
  useEffect(() => {
    if (!blockDragActive) return

    function onMove(e: MouseEvent) {
      const g = blockDragRef.current
      if (!g) return
      const pt = pointToGrid(e.clientX, e.clientY)
      if (!pt) return

      let dayIdx = g.originDayIdx
      let startMin = g.originStartMin
      let endMin = g.originEndMin

      if (g.kind === 'move') {
        // Duration preserved exactly: the start is clamped into the day and the
        // end follows it. Horizontal travel is a column delta, so a block can
        // cross to another day of the displayed week.
        const duration = g.originEndMin - g.originStartMin
        dayIdx = Math.max(0, Math.min(6, g.originDayIdx + (pt.dayIdx - g.grabDayIdx)))
        startMin = Math.max(0, Math.min(DAY_MINUTES - duration, g.originStartMin + (pt.min - g.grabMin)))
        endMin = startMin + duration
      } else if (g.kind === 'resize-top') {
        // Vertical only, same day, far edge fixed, minimum one 30-minute slot.
        startMin = Math.max(0, Math.min(g.originEndMin - 30, pt.min))
      } else {
        endMin = Math.min(DAY_MINUTES, Math.max(g.originStartMin + 30, pt.min))
      }

      // Snapping means most mousemoves land on the same half hour; bailing here
      // keeps the re-render count to one per snap step rather than one per pixel.
      if (dayIdx === g.dayIdx && startMin === g.startMin && endMin === g.endMin) return
      const next: BlockDragState = {
        ...g,
        dayIdx,
        startMin,
        endMin,
        changed:
          dayIdx !== g.originDayIdx ||
          startMin !== g.originStartMin ||
          endMin !== g.originEndMin,
      }
      blockDragRef.current = next
      setBlockDrag(next)
    }

    function onUp() {
      const g = blockDragRef.current
      blockDragRef.current = null
      setBlockDrag(null)
      // Picked up and dropped in place: nothing to say to the server.
      if (!g || !g.changed) return
      void commitBlockDrag(g)
    }

    // Alt-tabbing away mid-drag abandons the gesture rather than leaving a
    // stuck ghost behind, and writes nothing. Same abort contract
    // GeneralAvailability uses for its drag.
    function onAbort() {
      blockDragRef.current = null
      setBlockDrag(null)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onAbort)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onAbort)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockDragActive])

  async function confirmDelete() {
    if (!pendingDelete) return
    const id = pendingDelete
    setIsDeleting(true)
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
      setIsDeleting(false)
    }
  }

  async function exportClassesToCalendar() {
    setIsExporting(true)
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
      const icsText = buildIcsCalendar(
        upcoming.map(c => ({
          uid: `${c.id}@lingualinkonline.com`,
          startIso: c.scheduled_at,
          endIso: new Date(new Date(c.scheduled_at).getTime() + c.duration_minutes * 60_000).toISOString(),
          summary: c.student_name,
          description: `Class with ${c.student_name}`,
        }))
      )
      const blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lingualink-classes-${toLocalDateStr(new Date())}.ics`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportMsg('Could not load classes — please try again')
      setTimeout(() => setExportMsg(''), 3000)
    } finally {
      setIsExporting(false)
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

  // Ghost for a live move/resize: the record's whole prospective range, in the
  // column it would land in. The real block never leaves its stored position
  // until the server confirms, so a failed PATCH needs no rollback - clearing
  // the ghost is the rollback.
  const blockDragPreview = useMemo(() => {
    if (!blockDrag) return null
    const topPx = pxFromMin(blockDrag.startMin)
    return {
      dayIdx: blockDrag.dayIdx,
      topPx,
      heightPx: pxFromMin(blockDrag.endMin) - topPx,
      startMin: blockDrag.startMin,
      endMin: blockDrag.endMin,
      isAvailable: blockDrag.isAvailable,
    }
  }, [blockDrag])

  // Where the selected record's action button hangs. The label-host segment is
  // the record's largest visible piece, so it is the one with room beside it;
  // the button itself renders as a sibling of the blocks rather than a child,
  // because a block sets overflow:hidden and a short one would clip it away.
  // Null when nothing is selected, or when the selected id has been retired
  // under us (a delete, or a reconcile from another write).
  const selectedAnchor = useMemo(() => {
    if (!selectedRecordId) return null
    const own = [...availabilitySegments.green, ...availabilitySegments.red]
      .filter(s => s.recordId === selectedRecordId)
    if (own.length === 0) return null
    const host = own.find(s => s.labelHost) ?? own[0]
    return { dayIdx: host.dayIdx, topPx: pxFromMin(host.startMin) }
  }, [selectedRecordId, availabilitySegments])

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
    clearBlockSelection()
    setWeekStart(addDays(weekStart, delta))
  }

  function goToToday() {
    setDrag(null)
    isDraggingRef.current = false
    clearBlockSelection()
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
    clearBlockSelection()
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
    clearBlockSelection()
    setWeekStart(getMondayWeekStart(day))
    setViewMode('week')
  }

  return (
    <div>
      {/* Sticky toolbar: rows 1 & 2 stick to the scrolling <main> */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, backgroundColor: '#F9FAFB', borderBottom: viewMode === 'week' ? 'none' : '1px solid #E5E7EB', paddingTop: '12px', paddingBottom: viewMode === 'week' ? 0 : '12px', marginBottom: viewMode === 'week' ? 0 : '12px' }}>
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
        <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-start' }}>
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
        <span style={{ flex: 'none', fontSize: '16px', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', padding: '0 12px' }}>{viewMode === 'month' ? `${MONTHS_LONG[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}` : formatWeekLabel(weekStart)}</span>
        <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={exportClassesToCalendar}
          disabled={isExporting}
          title="Downloads a one-time snapshot file of your current schedule. It does not update."
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
            cursor: isExporting ? 'wait' : 'pointer',
            opacity: isExporting ? 0.7 : 1,
          }}
        >
          <Download size={14} />
          {isExporting ? 'Exporting...' : 'Download snapshot'}
        </button>
        </div>
      </div>
      {viewMode === 'week' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '8px 14px', backgroundColor: '#ffffff', border: '1px solid #E0DFDC', borderBottom: '1px solid #E5E7EB', borderRadius: '8px 8px 0 0', marginTop: '12px' }}>
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
      </div>

      {viewMode === 'week' && (
        <>
      {/* Calendar grid */}
      <div style={{
        background: '#ffffff',
        borderRadius: '0 0 8px 8px',
        border: '1px solid #E0DFDC',
        borderTop: 'none',
        overflow: 'hidden',
      }}>
      <div
        ref={scrollRef}
        className="thin-scroll"
        style={{
          background: '#ffffff',
          padding: '0',
          cursor: mode ? 'crosshair' : 'default',
          maxHeight: 'calc(100vh - 300px)',
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
              <div key={`d-${dayIdx}`} ref={el => { dayColRefs.current[dayIdx] = el }} style={{
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

                {/* Layer 1: specific available (green) - split around booked classes */}
                {availabilitySegments.green.filter(b => b.dayIdx === dayIdx).map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  // Green holds only type='specific' rows (the memo filters on
                  // it), so editable here comes down to source - a google_sync
                  // row keeps its unchanged click-to-delete path below.
                  const editable = isEditableBlock(b)
                  const selected = editable && b.recordId === selectedRecordId
                  const saving = movingRecordId === b.recordId
                  // Already started: still selectable and deletable, never
                  // movable. Read off the 60s now tick so a block crossing its
                  // start time loses the affordance without a reload.
                  const past = b.startMs < now.getTime()
                  const draggable = selected && !past && movingRecordId === null
                  return (
                    <div
                      key={`av-${b.recordId}-${i}`}
                      onMouseDown={draggable ? e => beginBlockGesture(e, 'move', b, true) : undefined}
                      onClick={() => {
                        setActionError('')
                        if (!editable) { setSelectedRecordId(null); setPendingDelete(b.recordId); return }
                        setSelectedRecordId(b.recordId)
                      }}
                      style={{
                        position: 'absolute',
                        top, left: '2px', right: '2px', height,
                        backgroundColor: '#F0FDF4',
                        border: '1px solid #BBF7D0',
                        borderLeft: '3px solid #16A34A',
                        borderRadius: segmentRadius(b),
                        boxShadow: selected
                          ? '0 1px 2px rgba(0,0,0,0.06), 0 0 0 2px #16A34A'
                          : '0 1px 2px rgba(0,0,0,0.06)',
                        padding: '3px 6px',
                        cursor: saving ? 'progress' : (draggable ? 'grab' : 'pointer'),
                        opacity: saving ? 0.55 : 1,
                        zIndex: 2,
                        overflow: 'hidden',
                      }}
                    >
                      {/* Resize handles. Only on a selected, movable block, and
                          only at an edge that is the RUN's true edge - a
                          booking cut is not a resizable boundary. */}
                      {draggable && b.roundTop && (
                        <div
                          onMouseDown={e => beginBlockGesture(e, 'resize-top', b, true)}
                          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '7px', cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}
                        >
                          <div style={{ width: '22px', height: '3px', borderRadius: '2px', backgroundColor: '#16A34A', opacity: 0.65 }} />
                        </div>
                      )}
                      {draggable && b.roundBottom && (
                        <div
                          onMouseDown={e => beginBlockGesture(e, 'resize-bottom', b, true)}
                          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '7px', cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}
                        >
                          <div style={{ width: '22px', height: '3px', borderRadius: '2px', backgroundColor: '#16A34A', opacity: 0.65 }} />
                        </div>
                      )}
                      {b.labelHost && (height >= 44 ? (
                        <>
                          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                            <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#374151' }}>Available</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#6B7280' }}>{timeRangeLabel(b.runStartMin, b.runEndMin)}</div>
                          {height >= 68 && (
                            <div style={{ fontSize: '10.5px', color: '#9CA3AF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Available for bookings</div>
                          )}
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: '#4B5563', whiteSpace: 'nowrap' }}>{timeRangeLabel(b.runStartMin, b.runEndMin)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}

                {/* Layer 1: specific unavailable + holiday (red) - split around booked classes */}
                {availabilitySegments.red
                  .filter(b => b.dayIdx === dayIdx)
                  // Google-owned segments paint FIRST, i.e. underneath. Every red
                  // segment shares zIndex 2, so paint order is array order: a google
                  // block ordered last would sit on top of an overlapping manual one
                  // and swallow its click, and that manual block would then be
                  // unreachable from anywhere in the UI (the other two tabs list only
                  // general/holiday rows) - permanently undeletable. Manual blocks are
                  // the only actionable ones, so they take the top layer. .sort() is
                  // stable (ES2019+) and runs on the array filter() just returned, so
                  // it neither reorders same-kind blocks nor mutates the memo. It is a
                  // no-op while every row is manual.
                  .sort((x, y) => Number(isGoogleBlock(y.source)) - Number(isGoogleBlock(x.source)))
                  .map((b, i) => {
                  const top = pxFromMin(b.startMin)
                  const height = pxFromMin(b.endMin) - top
                  if (height <= 0) return null
                  // Google-owned blocks keep the identical red palette - they block
                  // bookings exactly like a manual one - and differ only by the lock,
                  // the label, and where the click goes. Manual blocks render and
                  // behave exactly as before.
                  const isGoogle = isGoogleBlock(b.source)
                  // The red layer mixes timed 'specific' rows with whole-day
                  // 'holiday' ones and with google_sync rows. Only the first
                  // kind is editable; the other two keep the exact click they
                  // have today (the explainer for google, the delete
                  // confirmation for a holiday) and get no drag affordance.
                  const editable = isEditableBlock(b)
                  const selected = editable && b.recordId === selectedRecordId
                  const saving = movingRecordId === b.recordId
                  const past = b.startMs < now.getTime()
                  const draggable = selected && !past && movingRecordId === null
                  return (
                    <div
                      key={`un-${b.recordId}-${i}`}
                      title={isGoogle ? 'From Google Calendar - manage this event in Google Calendar' : undefined}
                      onMouseDown={draggable ? e => beginBlockGesture(e, 'move', b, false) : undefined}
                      onClick={() => {
                        setActionError('')
                        if (isGoogle) { setSelectedRecordId(null); setGoogleBlockInfo(true); return }
                        if (!editable) { setSelectedRecordId(null); setPendingDelete(b.recordId); return }
                        setSelectedRecordId(b.recordId)
                      }}
                      style={{
                        position: 'absolute',
                        top, left: '2px', right: '2px', height,
                        backgroundColor: '#FEF2F2',
                        border: '1px solid #FECACA',
                        borderLeft: '3px solid #DC2626',
                        borderRadius: segmentRadius(b),
                        boxShadow: selected ? '0 0 0 2px #DC2626' : undefined,
                        padding: '3px 6px',
                        cursor: saving ? 'progress' : (draggable ? 'grab' : 'pointer'),
                        opacity: saving ? 0.55 : 1,
                        zIndex: 2,
                        overflow: 'hidden',
                      }}
                    >
                      {draggable && b.roundTop && (
                        <div
                          onMouseDown={e => beginBlockGesture(e, 'resize-top', b, false)}
                          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '7px', cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}
                        >
                          <div style={{ width: '22px', height: '3px', borderRadius: '2px', backgroundColor: '#DC2626', opacity: 0.65 }} />
                        </div>
                      )}
                      {draggable && b.roundBottom && (
                        <div
                          onMouseDown={e => beginBlockGesture(e, 'resize-bottom', b, false)}
                          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '7px', cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}
                        >
                          <div style={{ width: '22px', height: '3px', borderRadius: '2px', backgroundColor: '#DC2626', opacity: 0.65 }} />
                        </div>
                      )}
                      {b.labelHost && (height >= 44 ? (
                        <>
                          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                            {isGoogle && (
                              <Lock size={11} color="#B91C1C" strokeWidth={2.5} aria-hidden="true" style={{ flexShrink: 0 }} />
                            )}
                            <span style={
                              isGoogle
                                ? { fontSize: '11.5px', fontWeight: 600, color: '#B91C1C', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                                : { fontSize: '11.5px', fontWeight: 600, color: '#B91C1C' }
                            }>
                              {isGoogle ? 'From Google Calendar' : 'Unavailable'}
                            </span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#B91C1C' }}>{timeRangeLabel(b.runStartMin, b.runEndMin)}</div>
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          {isGoogle && (
                            <Lock size={10} color="#B91C1C" strokeWidth={2.5} aria-hidden="true" style={{ flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: '11px', color: '#B91C1C', whiteSpace: 'nowrap' }}>{timeRangeLabel(b.runStartMin, b.runEndMin)}</span>
                        </div>
                      ))}
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
                    <div key={`cl-${i}`} title={b.studentName} onClick={() => { setSelectedRecordId(null); setClassDetail({ studentName: b.studentName, dayIdx: b.dayIdx, startMin: b.startMin, endMin: b.endMin }) }} style={{
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

                {/* Move/resize ghost. Same visual language as the drag-create
                    preview above, but keyed on the dragged record's own
                    polarity rather than the armed mode - a move has no mode. */}
                {blockDragPreview && blockDragPreview.dayIdx === dayIdx && blockDragPreview.heightPx > 0 && (
                  <div style={{
                    position: 'absolute',
                    top: blockDragPreview.topPx,
                    height: blockDragPreview.heightPx,
                    left: '2px', right: '2px',
                    background: blockDragPreview.isAvailable
                      ? 'rgba(220,252,231,0.85)'
                      : 'repeating-linear-gradient(45deg, rgba(220,38,38,0.16) 0 6px, rgba(220,38,38,0.04) 6px 12px)',
                    border: `1px dashed ${blockDragPreview.isAvailable ? '#16A34A' : '#DC2626'}`,
                    borderRadius: '8px',
                    pointerEvents: 'none',
                    zIndex: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: blockDragPreview.isAvailable ? '#15803D' : '#B91C1C',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}>
                    {timeRangeLabel(blockDragPreview.startMin, blockDragPreview.endMin)}
                  </div>
                )}

                {/* Selected block's actions. A sibling of the blocks, not a
                    child: a block sets overflow:hidden, so a short one (or one
                    cut down by a booking) would clip the button away and leave
                    the record undeletable. zIndex 6 clears every layer. */}
                {selectedAnchor && selectedAnchor.dayIdx === dayIdx && (
                  <div style={{ position: 'absolute', top: selectedAnchor.topPx + 3, right: '5px', zIndex: 6 }}>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        setActionError('')
                        if (selectedRecordId) setPendingDelete(selectedRecordId)
                      }}
                      disabled={movingRecordId !== null}
                      style={{
                        padding: '2px 8px',
                        borderRadius: '6px',
                        border: '1px solid #FECACA',
                        backgroundColor: '#ffffff',
                        color: '#B91C1C',
                        fontSize: '10.5px',
                        fontWeight: 600,
                        lineHeight: 1.5,
                        cursor: movingRecordId !== null ? 'progress' : 'pointer',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
                      }}
                    >
                      {movingRecordId !== null ? 'Saving...' : 'Delete'}
                    </button>
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
      </div>

      <p style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '12px' }}>
        Click a green or red block to select it, then drag it to move it or drag its top or bottom edge to resize.
        Use Delete on the selected block to remove it. Blocks that have already started can be deleted but not moved.
        Booked classes cannot be removed here.
        {hasGoogleBlock && ' Blocks marked with a lock come from Google Calendar and are managed there.'}
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
                disabled={isDeleting}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: 'none',
                  backgroundColor: '#DC2626', color: '#ffffff', fontSize: '13px',
                  fontWeight: '600', cursor: isDeleting ? 'wait' : 'pointer', opacity: isDeleting ? 0.7 : 1,
                }}
              >
                {isDeleting ? 'Removing...' : 'Remove'}
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

      {/* Google-synced block explainer. Non-destructive by design: Google Calendar
          owns these rows, so there is nothing to confirm here - only a Close. Same
          shell as the class-detail modal above. */}
      {googleBlockInfo && (
        <div
          onClick={() => setGoogleBlockInfo(false)}
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
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
              <Lock size={15} color="#B91C1C" aria-hidden="true" style={{ flexShrink: 0 }} />
              <p style={{ fontSize: '16px', fontWeight: 600, color: '#111827' }}>
                From Google Calendar
              </p>
            </div>
            <p style={{ fontSize: '13px', color: '#374151', marginBottom: '20px', lineHeight: 1.5 }}>
              This block comes from your Google Calendar. To free this time, delete or move
              the event in Google Calendar - the portal updates within 15 minutes.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setGoogleBlockInfo(false)}
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
