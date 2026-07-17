import type { createAdminClient } from '@/lib/supabase/admin'
import { getLocalDateKey, addDaysToDateKey } from '@/lib/utils/timezone'

type AdminClient = ReturnType<typeof createAdminClient>

interface AvailabilityRecord {
  type: string
  day_of_week: number | null
  start_time: string | null
  end_time: string | null
  start_at: string | null
  end_at: string | null
  is_available: boolean
}

// Convert a "HH:MM:SS" time on a specific YYYY-MM-DD date from a named timezone to UTC ms.
// NEW326: the offset probe compares full local DATETIMEs (date + time), never the wall
// clock alone. A bare hour:minute diff is ambiguous at exactly ±720 min (+12h and -12h
// produce identical wall clocks) and the old wrap clamp mis-normalised every offset at
// or beyond ±12h — UTC+12 (Pacific/Auckland NZST) afternoons and all NZDT (+13) times
// resolved one day off. With the observed local DATE in the comparison the diff IS the
// true offset, so no wrap clamp is needed. This is the same probe localToUtc in
// @/lib/utils/timezone uses. Inside a DST spring-forward gap the requested wall time
// does not exist; the single-pass probe then returns a best-effort instant that can be
// off by the DST delta (same approximation as before the rewrite).
export function localTimeToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, m] = timeStr.split(':').map(Number)
  const intendedLocalMs = Date.UTC(y, mo - 1, d, h, m, 0)
  const guessUtc = new Date(intendedLocalMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(guessUtc)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const observedLocalMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), 0)
  return guessUtc.getTime() + (intendedLocalMs - observedLocalMs)
}

// Check whether two time ranges overlap.
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

// Total weekly minutes offered via committed general-availability slots. Each
// general row is one 30-min slot, so the count of rows × 30 is the weekly total.
// The `temp-` id filter is a client optimistic-UI concern (drag-in-progress
// placeholders); it is a no-op for server-fetched rows, which never carry temp ids.
export function weeklyGeneralMinutes(records: { id: string; type: string }[]): number {
  return records.filter(r => r.type === 'general' && !r.id.startsWith('temp-')).length * 30
}

// Returns true if every 30-min segment of the requested booking falls within
// the teacher's set availability. Does NOT check lesson-vs-lesson clash
// (handled separately) and does NOT enforce the 24h rule (handled separately).
export async function isSlotAvailable(
  teacherId: string,
  scheduledAtUtc: string,
  durationMinutes: number,
  adminClient: AdminClient
): Promise<boolean> {
  const { data: teacherProfile, error: tzError } = await adminClient
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .maybeSingle()
  if (tzError) {
    throw new Error(`isSlotAvailable: timezone lookup failed for teacher ${teacherId}: ${tzError.message}`)
  }
  if (!teacherProfile?.timezone) {
    throw new Error(`isSlotAvailable: teacher ${teacherId} has no timezone set`)
  }
  const teacherTimezone = teacherProfile.timezone

  const requestedStartMs = new Date(scheduledAtUtc).getTime()
  const requestedEndMs = requestedStartMs + durationMinutes * 60 * 1000

  // NEW175 + NEW325 (addresses M5, S81/S91): the teacher's general availability and
  // holidays are expressed in the teacher's LOCAL calendar (local weekday, local dates).
  // A booking instant's UTC date can land on a different calendar day near UTC midnight
  // for teachers far from UTC (e.g. Tokyo, New York), and a 60/90-min booking can itself
  // cross teacher-local midnight and span TWO local dates. So general slots are built
  // for every teacher-local date the requested window [start, end) touches — each date
  // contributing its own weekday's records — and holidays block per-slot by the
  // teacher-local date of each slot's own start instant, mirroring slotEngine (NEW317).
  // This keeps the gate in agreement with the displayed booking calendar. Timed
  // 'specific' overrides stay exact-instant.

  const { data: availabilityData } = await adminClient
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  const records: AvailabilityRecord[] = availabilityData ?? []
  const generalRecords = records.filter((r) => r.type === 'general')
  const overrideRecords = records.filter((r) => r.type !== 'general' && r.start_at && r.end_at)

  // NEW174: holidays block whole calendar DATES, compared by the stored date portion
  // (YYYY-MM-DD), never by the localised instant - this mirrors the student availability
  // grid so the booking gate and the displayed calendar agree. Timed 'specific'
  // unavailability still blocks by exact instant below. LOAD-BEARING: the date-portion
  // match only works because Holidays.tsx saves offset-less date strings stored as UTC; if
  // that save path is changed to send true UTC instants, holidays shift a day - update all readers.
  const holidayBlockedDates = new Set<string>()
  for (const r of overrideRecords) {
    if (r.type !== 'holiday' || r.is_available) continue
    let d = r.start_at!.split('T')[0]
    const endDate = r.end_at!.split('T')[0]
    while (d <= endDate) {
      holidayBlockedDates.add(d)
      const [yy, mm, dd] = d.split('-').map(Number)
      const next = new Date(yy, mm - 1, dd + 1)
      d = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
    }
  }

  // Build available slots from general weekly records for every teacher-local
  // date the requested window [start, end) touches — 1 or 2 dates for 30/90-min
  // bookings, 2 when the booking crosses teacher-local midnight (NEW325).
  const firstLocalDate = getLocalDateKey(new Date(requestedStartMs), teacherTimezone)
  const lastLocalDate = getLocalDateKey(new Date(requestedEndMs - 1), teacherTimezone)
  const slots: { startIso: string; available: boolean }[] = []
  for (
    let dateStr = firstLocalDate;
    dateStr <= lastLocalDate; // YYYY-MM-DD compares safely as a string
    dateStr = addDaysToDateKey(dateStr, 1)
  ) {
    // A bare calendar date's weekday is timezone-independent, so derive it from
    // the UTC-anchored parse of the teacher-local date string (NEW175).
    const dayOfWeek = new Date(dateStr + 'T00:00:00.000Z').getUTCDay()
    for (const r of generalRecords) {
      if (r.day_of_week !== dayOfWeek || !r.start_time || !r.end_time) continue
      const startIso = new Date(localTimeToUtcMs(dateStr, r.start_time, teacherTimezone)).toISOString()
      if (!slots.find((s) => s.startIso === startIso)) {
        slots.push({ startIso, available: true })
      }
    }
  }

  // NEW322: add specific is_available=true override slots selected by instant
  // overlap with the requested booking window [start, start + duration). The
  // old UTC-date prefix match on start_at missed overrides straddling UTC
  // midnight, which the display grid (slotEngine) selects by overlap since
  // NEW317 — the grid could offer a slot this gate then rejected.
  const addOverrides = overrideRecords.filter(
    (o) =>
      o.is_available &&
      rangesOverlap(new Date(o.start_at!).getTime(), new Date(o.end_at!).getTime(), requestedStartMs, requestedEndMs)
  )
  for (const o of addOverrides) {
    let cursor = new Date(o.start_at!).getTime()
    const overrideEnd = new Date(o.end_at!).getTime()
    while (cursor + 30 * 60 * 1000 <= overrideEnd) {
      const startIso = new Date(cursor).toISOString()
      if (!slots.find((s) => s.startIso === startIso)) {
        slots.push({ startIso, available: true })
      }
      cursor += 30 * 60 * 1000
    }
  }

  // Apply is_available=false blocking overrides (timed 'specific' only).
  // Holidays are excluded here - handled as whole calendar dates below (NEW174).
  const blockOverrides = overrideRecords.filter((o) => !o.is_available && o.type !== 'holiday')
  for (const slot of slots) {
    if (!slot.available) continue
    const slotStart = new Date(slot.startIso).getTime()
    const slotEnd = slotStart + 30 * 60 * 1000
    for (const block of blockOverrides) {
      if (rangesOverlap(slotStart, slotEnd, new Date(block.start_at!).getTime(), new Date(block.end_at!).getTime())) {
        slot.available = false
        break
      }
    }
  }

  // NEW174 + NEW325: a slot is blocked when the teacher-local calendar date of
  // its OWN start instant is a holiday (holiday wins over general and add-override
  // slots). Per-slot, not whole-request-day: a booking crossing teacher-local
  // midnight must be blocked when EITHER date it touches is a holiday, and the
  // start date alone must not decide. Matches slotEngine's holiday block exactly.
  if (holidayBlockedDates.size > 0) {
    for (const slot of slots) {
      if (!slot.available) continue
      if (holidayBlockedDates.has(getLocalDateKey(new Date(slot.startIso), teacherTimezone))) {
        slot.available = false
      }
    }
  }

  // Every 30-min segment of the requested duration must map to an available slot
  const slotsNeeded = durationMinutes / 30
  for (let i = 0; i < slotsNeeded; i++) {
    const segmentStart = new Date(requestedStartMs + i * 30 * 60 * 1000).toISOString()
    const slot = slots.find((s) => s.startIso === segmentStart)
    if (!slot || !slot.available) return false
  }

  return true
}
