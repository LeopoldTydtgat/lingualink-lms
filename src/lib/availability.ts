import type { createAdminClient } from '@/lib/supabase/admin'

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
export function localTimeToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  const guessUtc = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`)
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: timezone }).format(guessUtc)
  )
  const localMinute = Number(
    new Intl.DateTimeFormat('en-GB', { minute: '2-digit', timeZone: timezone }).format(guessUtc)
  )
  let diffMinutes = (h - localHour) * 60 + (m - localMinute)
  // Normalise across midnight: any diff > 12h means we wrapped a day,
  // any diff < -12h means we wrapped the other way.
  if (diffMinutes > 12 * 60) diffMinutes -= 24 * 60
  if (diffMinutes < -12 * 60) diffMinutes += 24 * 60
  return guessUtc.getTime() + diffMinutes * 60 * 1000
}

// Check whether two time ranges overlap.
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
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

  // NEW175 (addresses M5, S81/S91): the teacher's general availability and holidays are
  // expressed in the teacher's LOCAL calendar (local weekday, local dates). A booking
  // instant's UTC date can land on a different calendar day near UTC midnight for teachers
  // far from UTC (e.g. Tokyo, New York), so keying off the UTC date silently mismatched.
  // Derive the teacher-local calendar date of the requested instant and key the general
  // weekday, the general slot build, and holiday blocking off THAT, so this gate agrees
  // with the displayed booking calendar. Timed 'specific' overrides stay exact-instant.
  const localDateStr = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: teacherTimezone,
  }).format(new Date(scheduledAtUtc))

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

  // A bare calendar date's weekday is timezone-independent, so derive it from the
  // teacher-local date string (NEW175).
  const date = new Date(localDateStr + 'T00:00:00.000Z')
  const dayOfWeek = date.getUTCDay()

  // Build available slots from general weekly records for this day
  const slots: { startIso: string; available: boolean }[] = generalRecords
    .filter((r) => r.day_of_week === dayOfWeek && r.start_time && r.end_time)
    .map((r) => ({
      startIso: new Date(localTimeToUtcMs(localDateStr, r.start_time!, teacherTimezone)).toISOString(),
      available: true,
    }))

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

  // NEW174 + NEW175: if the requested instant falls on a teacher-local holiday date,
  // block the whole day (holiday wins).
  if (holidayBlockedDates.has(localDateStr)) {
    for (const slot of slots) slot.available = false
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
