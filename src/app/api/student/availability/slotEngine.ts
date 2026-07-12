import { localToUtc, getLocalDateKey, addDaysToDateKey } from '@/lib/utils/timezone'
import { localTimeToUtcMs, rangesOverlap } from '@/lib/availability'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AvailabilityRecord {
  type: string
  day_of_week: number | null
  start_time: string | null    // "HH:MM:SS" in teacher's local timezone
  end_time: string | null      // "HH:MM:SS" in teacher's local timezone
  start_at: string | null      // UTC timestamp — used for overrides
  end_at: string | null        // UTC timestamp — used for overrides
  is_available: boolean
}

export interface BookedLesson {
  scheduled_at: string
  duration_minutes: number
}

export interface Slot {
  startIso: string   // UTC ISO string
  available: boolean
}

const SLOT_MS = 30 * 60 * 1000

// Longest bookable lesson (30/60/90 min). The booked-lessons fetch must widen
// BOTH bounds by this much: a lesson that STARTS just before the week window
// still blocks the slots it overlaps inside it, and one starting at/after the
// window end still blocks the NEW324 extended slots past it.
export const MAX_LESSON_MS = 90 * 60 * 1000

// ─── Week window ──────────────────────────────────────────────────────────────

export interface WeekWindow {
  windowStartMs: number      // UTC instant of weekStart 00:00 in the display tz (inclusive)
  windowEndMs: number        // UTC instant of weekStart+7d 00:00 in the display tz (exclusive)
  displayDateKeys: string[]  // the 7 calendar dates of the requested week
}

/**
 * NEW317: the requested week is a span of 7 CALENDAR dates in the display
 * timezone (student tz for the student flow, teacher tz for the admin flows),
 * resolved to true UTC instants via localToUtc. On a DST-transition week the
 * window is genuinely 167 or 169 hours long — that is correct, not a bug.
 */
export function getWeekWindow(weekStart: string, displayTimezone: string): WeekWindow {
  const windowStartMs = new Date(localToUtc(weekStart + 'T00:00', displayTimezone)).getTime()
  const windowEndMs = new Date(
    localToUtc(addDaysToDateKey(weekStart, 7) + 'T00:00', displayTimezone)
  ).getTime()
  const displayDateKeys = Array.from({ length: 7 }, (_, i) => addDaysToDateKey(weekStart, i))
  return { windowStartMs, windowEndMs, displayDateKeys }
}

// ─── Slot engine ──────────────────────────────────────────────────────────────

export interface BuildWeekSlotsInput {
  weekStart: string          // YYYY-MM-DD — a calendar date in displayTimezone
  displayTimezone: string    // IANA tz the response keys are expressed in
  teacherTimezone: string    // IANA tz the general availability wall-clocks live in
  records: AvailabilityRecord[]
  booked: BookedLesson[]
  nowMs: number
  isAdmin: boolean           // admins bypass the 24h advisory cutoff (past still blocked)
}

/**
 * NEW317: per-SLOT bucketing. The old implementation bucketed whole teacher
 * days under a key derived from formatting UTC midnight in the display tz —
 * every UTC-negative display timezone shifted all keys one day back, and even
 * with aligned keys a single slot can genuinely fall on a different
 * display-local calendar day than the teacher-calendar date it was generated
 * from (Tokyo teacher Mon 08:00 = New York Sun 19:00). Here candidate slots
 * are generated in the teacher's calendar, filtered to the display-week's
 * true instant window, and each surviving slot is keyed by the display-local
 * date of ITS OWN start instant.
 *
 * NEW324 (engine half): candidate acceptance extends past windowEndMs by
 * MAX_LESSON_MS - SLOT_MS (60 min), so a 60/90-min lesson starting late on
 * the week's LAST display day has its continuation instants emitted too.
 * Those extended slots bucket under a day-8 display key — see the bucketing
 * note at the bottom.
 *
 * Blocking semantics are unchanged from the previous implementation:
 * - timed is_available=false overrides block by instant overlap;
 * - holidays block whole TEACHER-local calendar dates via the stored date
 *   portion (NEW174 — Holidays.tsx saves offset-less date strings stored as
 *   UTC, so the date portion IS the teacher-local date), matching
 *   isSlotAvailable's NEW175 per-instant teacher-local check;
 * - booked scheduled lessons block by instant overlap;
 * - slots in the past or within 24h are blocked (isAdmin bypasses the 24h
 *   part, matching the admin write path which enforces no such rule).
 */
export function buildWeekSlots(input: BuildWeekSlotsInput): Record<string, Slot[]> {
  const { weekStart, displayTimezone, teacherTimezone, records, booked, nowMs, isAdmin } = input

  const { windowStartMs, windowEndMs, displayDateKeys } = getWeekWindow(weekStart, displayTimezone)

  // NEW324: accept candidates up to 60 min past the window end — the latest
  // in-window start is windowEndMs - SLOT_MS, and a 90-min run from there
  // needs instants up to windowEndMs + MAX_LESSON_MS - 2*SLOT_MS.
  const candidateEndMs = windowEndMs + MAX_LESSON_MS - SLOT_MS

  const generalRecords = records.filter((r) => r.type === 'general')
  // Overrides use start_at/end_at which are already stored as UTC timestamps
  const overrideRecords = records.filter((r) => r.type !== 'general' && r.start_at && r.end_at)

  // NEW174: holidays block whole calendar DATES in the teacher's local frame,
  // derived from the stored date portion (YYYY-MM-DD), not the instant.
  const holidayBlockedDates = new Set<string>()
  for (const r of overrideRecords) {
    if (r.type !== 'holiday' || r.is_available) continue
    let d = r.start_at!.split('T')[0]
    const endDate = r.end_at!.split('T')[0]
    while (d <= endDate) {
      holidayBlockedDates.add(d)
      d = addDaysToDateKey(d, 1)
    }
  }

  // ── Candidate slots from general availability ───────────────────────────────
  // Iterate TEACHER-calendar dates covering the window, padded one day each
  // side: near midnight a teacher-local date's slots can fall on a display
  // date outside the naive 7-day span. Keyed by startIso for dedupe.
  const candidates = new Map<string, Slot>()

  const firstTeacherDate = addDaysToDateKey(
    getLocalDateKey(new Date(windowStartMs), teacherTimezone), -1
  )
  const lastTeacherDate = addDaysToDateKey(
    getLocalDateKey(new Date(windowEndMs - 1), teacherTimezone), 1
  )
  for (
    let dateStr = firstTeacherDate;
    dateStr <= lastTeacherDate;                 // YYYY-MM-DD compares safely as a string
    dateStr = addDaysToDateKey(dateStr, 1)
  ) {
    // A bare calendar date's weekday is timezone-independent, so deriving it
    // from the UTC-anchored parse of the date string is tz-safe (NEW175 pattern).
    const dayOfWeek = new Date(dateStr + 'T00:00:00.000Z').getUTCDay() // 0=Sun … 6=Sat

    for (const r of generalRecords) {
      if (r.day_of_week !== dayOfWeek || !r.start_time || !r.end_time) continue
      const startMs = localTimeToUtcMs(dateStr, r.start_time, teacherTimezone)
      if (startMs < windowStartMs || startMs >= candidateEndMs) continue
      const startIso = new Date(startMs).toISOString()
      if (!candidates.has(startIso)) candidates.set(startIso, { startIso, available: true })
    }
  }

  // ── Candidate slots from is_available=true overrides ───────────────────────
  // Selected by instant overlap with the window — a prefix match on the stored
  // start_at date would miss an override that starts on the previous UTC date.
  for (const o of overrideRecords) {
    if (!o.is_available) continue
    const overrideStart = new Date(o.start_at!).getTime()
    const overrideEnd = new Date(o.end_at!).getTime()
    if (overrideStart >= candidateEndMs || overrideEnd <= windowStartMs) continue
    let cursor = overrideStart
    while (cursor + SLOT_MS <= overrideEnd) {
      if (cursor >= windowStartMs && cursor < candidateEndMs) {
        const startIso = new Date(cursor).toISOString()
        if (!candidates.has(startIso)) candidates.set(startIso, { startIso, available: true })
      }
      cursor += SLOT_MS
    }
  }

  const slots = [...candidates.values()]

  // ── Block: timed is_available=false overrides (already UTC instants) ───────
  // Holidays are excluded here — handled as whole teacher-local dates (NEW174).
  const blockOverrides = overrideRecords.filter((o) => !o.is_available && o.type !== 'holiday')
  for (const slot of slots) {
    if (!slot.available) continue
    const slotStart = new Date(slot.startIso).getTime()
    const slotEnd = slotStart + SLOT_MS
    for (const block of blockOverrides) {
      if (rangesOverlap(slotStart, slotEnd, new Date(block.start_at!).getTime(), new Date(block.end_at!).getTime())) {
        slot.available = false
        break
      }
    }
  }

  // ── Block: holidays — the slot's OWN teacher-local calendar date ────────────
  if (holidayBlockedDates.size > 0) {
    for (const slot of slots) {
      if (!slot.available) continue
      if (holidayBlockedDates.has(getLocalDateKey(new Date(slot.startIso), teacherTimezone))) {
        slot.available = false
      }
    }
  }

  // ── Block: already booked lessons ───────────────────────────────────────────
  for (const slot of slots) {
    if (!slot.available) continue
    const slotStart = new Date(slot.startIso).getTime()
    const slotEnd = slotStart + SLOT_MS
    for (const lesson of booked) {
      const lessonStart = new Date(lesson.scheduled_at).getTime()
      const lessonEnd = lessonStart + lesson.duration_minutes * 60 * 1000
      if (rangesOverlap(slotStart, slotEnd, lessonStart, lessonEnd)) {
        slot.available = false
        break
      }
    }
  }

  // ── Block: slots within 24 hours (24-hour booking rule) or in the past ──────
  const cutoff = isAdmin ? nowMs : nowMs + 24 * 60 * 60 * 1000
  for (const slot of slots) {
    if (new Date(slot.startIso).getTime() < cutoff) {
      slot.available = false
    }
  }

  // ── Bucket each slot by the display-local date of ITS start instant ─────────
  const slotsByDate: Record<string, Slot[]> = {}
  for (const key of displayDateKeys) slotsByDate[key] = []
  for (const slot of slots) {
    // In-window slots key inside displayDateKeys; NEW324 extended slots
    // (start in [windowEndMs, candidateEndMs)) legitimately key under a
    // day-8 date via the ??= fallback. Intended: the frontend derives its
    // columns from its own 7 dates and reads these slots only for the
    // week-wide instant set (isBookableStart).
    const key = getLocalDateKey(new Date(slot.startIso), displayTimezone)
    ;(slotsByDate[key] ??= []).push(slot)
  }
  for (const key of Object.keys(slotsByDate)) {
    slotsByDate[key].sort((a, b) => a.startIso.localeCompare(b.startIso))
  }

  return slotsByDate
}
