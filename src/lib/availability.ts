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
  const diffMinutes = (h - localHour) * 60 + (m - localMinute)
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
  const { data: teacherProfile } = await adminClient
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .single()
  const teacherTimezone = teacherProfile?.timezone ?? 'UTC'

  const dateStr = scheduledAtUtc.slice(0, 10) // YYYY-MM-DD in UTC

  const { data: availabilityData } = await adminClient
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  const records: AvailabilityRecord[] = availabilityData ?? []
  const generalRecords = records.filter((r) => r.type === 'general')
  const overrideRecords = records.filter((r) => r.type !== 'general' && r.start_at && r.end_at)

  const date = new Date(dateStr + 'T00:00:00.000Z')
  const dayOfWeek = date.getUTCDay()

  // Build available slots from general weekly records for this day
  const slots: { startIso: string; available: boolean }[] = generalRecords
    .filter((r) => r.day_of_week === dayOfWeek && r.start_time && r.end_time)
    .map((r) => ({
      startIso: new Date(localTimeToUtcMs(dateStr, r.start_time!, teacherTimezone)).toISOString(),
      available: true,
    }))

  // Add specific is_available=true override slots for this UTC date
  const addOverrides = overrideRecords.filter((o) => o.is_available && o.start_at!.startsWith(dateStr))
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

  // Apply is_available=false blocking overrides (specific + holiday)
  const blockOverrides = overrideRecords.filter((o) => !o.is_available)
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

  // Every 30-min segment of the requested duration must map to an available slot
  const slotsNeeded = durationMinutes / 30
  const requestedStartMs = new Date(scheduledAtUtc).getTime()
  for (let i = 0; i < slotsNeeded; i++) {
    const segmentStart = new Date(requestedStartMs + i * 30 * 60 * 1000).toISOString()
    const slot = slots.find((s) => s.startIso === segmentStart)
    if (!slot || !slot.available) return false
  }

  return true
}
