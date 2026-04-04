import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AvailabilityRecord {
  type: string
  day_of_week: number | null
  start_time: string | null    // "HH:MM:SS" in teacher's local timezone
  end_time: string | null      // "HH:MM:SS" in teacher's local timezone
  start_at: string | null      // UTC timestamp — used for overrides
  end_at: string | null        // UTC timestamp — used for overrides
  is_available: boolean
}

interface BookedLesson {
  scheduled_at: string
  duration_minutes: number
}

interface Slot {
  startIso: string   // UTC ISO string
  available: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Convert a "HH:MM:SS" time on a specific YYYY-MM-DD date from a named timezone to UTC ms.
// e.g. "08:00:00" on "2026-04-07" in "Europe/London" → UTC ms for 07:00:00Z
function localTimeToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
  const [h, m] = timeStr.split(':').map(Number)

  // Build an ISO-like string that represents this wall-clock time in the given timezone,
  // then use Intl to figure out the UTC offset at that moment.
  // Strategy: format a known UTC time in the target timezone until we find the one
  // whose local representation matches our target. We do this by constructing the
  // local datetime string and resolving it via a binary-search-free offset calculation.

  // Step 1: Assume UTC first as a starting guess
  const guessUtc = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`)

  // Step 2: Find what local time that UTC moment corresponds to in the teacher's timezone
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: timezone }).format(guessUtc)
  )
  const localMinute = Number(
    new Intl.DateTimeFormat('en-GB', { minute: '2-digit', timeZone: timezone }).format(guessUtc)
  )

  // Step 3: Calculate the offset difference and adjust
  const diffMinutes = (h - localHour) * 60 + (m - localMinute)
  return guessUtc.getTime() - diffMinutes * 60 * 1000
}

// Check whether two time ranges overlap
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const teacherId = searchParams.get('teacherId')
  const weekStart = searchParams.get('weekStart') // YYYY-MM-DD (Monday)
  const studentTimezone = searchParams.get('timezone') ?? 'UTC'

  if (!teacherId || !weekStart) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }

  // Build the 7 YYYY-MM-DD strings for this week
  const weekDates: string[] = []
  const baseDate = new Date(weekStart + 'T00:00:00.000Z')
  for (let i = 0; i < 7; i++) {
    const d = new Date(baseDate)
    d.setUTCDate(d.getUTCDate() + i)
    weekDates.push(d.toISOString().slice(0, 10))
  }
  const weekEndDate = weekDates[6]

  // ── Fetch teacher's timezone ────────────────────────────────────────────────

  const { data: teacherProfile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .single()

  // Fall back to UTC if teacher has no timezone set
  const teacherTimezone = teacherProfile?.timezone ?? 'UTC'

  // ── Fetch availability records ──────────────────────────────────────────────

  const { data: availabilityData } = await supabase
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  // Already booked lessons for this teacher this week
  const { data: bookedLessons } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', teacherId)
    .eq('status', 'scheduled')
    .gte('scheduled_at', weekStart + 'T00:00:00.000Z')
    .lte('scheduled_at', weekEndDate + 'T23:59:59.999Z')

  const records: AvailabilityRecord[] = availabilityData ?? []
  const booked: BookedLesson[] = bookedLessons ?? []

  const generalRecords = records.filter((r) => r.type === 'general')
  // Overrides use start_at/end_at which are already stored as UTC timestamps
  const overrideRecords = records.filter((r) => r.type !== 'general' && r.start_at && r.end_at)

  // ── Build slots per day ─────────────────────────────────────────────────────

  const slotsByDate: Record<string, Slot[]> = {}

  for (const dateStr of weekDates) {
    const date = new Date(dateStr + 'T00:00:00.000Z')
    const dayOfWeek = date.getUTCDay() // 0=Sun, 1=Mon ... 6=Sat

    // Find general availability slots for this day of week
    const dayGeneralRecords = generalRecords.filter(
      (r) => r.day_of_week === dayOfWeek && r.start_time && r.end_time
    )

    // Convert each slot's start time from teacher's local timezone to UTC ms
    const slots: Slot[] = dayGeneralRecords.map((r) => ({
      startIso: new Date(
        localTimeToUtcMs(dateStr, r.start_time!, teacherTimezone)
      ).toISOString(),
      available: true,
    }))

    // Add is_available=true override slots for this date (already UTC)
    const addOverrides = overrideRecords.filter(
      (o) => o.is_available && o.start_at!.startsWith(dateStr)
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

    // Sort by start time
    slots.sort((a, b) => a.startIso.localeCompare(b.startIso))

    // Block slots covered by is_available=false overrides (already UTC)
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

    // Block slots that overlap with already booked lessons
    for (const slot of slots) {
      if (!slot.available) continue
      const slotStart = new Date(slot.startIso).getTime()
      const slotEnd = slotStart + 30 * 60 * 1000
      for (const lesson of booked) {
        const lessonStart = new Date(lesson.scheduled_at).getTime()
        const lessonEnd = lessonStart + lesson.duration_minutes * 60 * 1000
        if (rangesOverlap(slotStart, slotEnd, lessonStart, lessonEnd)) {
          slot.available = false
          break
        }
      }
    }

    // Block slots in the past
    const now = Date.now()
    for (const slot of slots) {
      if (new Date(slot.startIso).getTime() < now) {
        slot.available = false
      }
    }

    // Key by YYYY-MM-DD in the student's timezone so BookingClient can group correctly
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: studentTimezone,
    }).format(date)

    slotsByDate[dateKey] = slots
  }

  return NextResponse.json({ slots: slotsByDate })
}
