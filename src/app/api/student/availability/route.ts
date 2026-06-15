import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { localTimeToUtcMs, rangesOverlap } from '@/lib/availability'

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

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Detect admin/staff caller: they bypass the 24hr booking rule (enforced
  // independently on the write paths, e.g. student/book/route.ts), so the
  // 24hr-derived advisory cutoff below should not apply to them. Students
  // have no profiles row -> maybeSingle returns null -> isAdmin false.
  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .maybeSingle()
  const isAdmin =
    callerProfile?.account_types?.includes('school_admin') ||
    callerProfile?.account_types?.includes('staff')

  const { searchParams } = new URL(req.url)
  const teacherId = searchParams.get('teacherId')
  const weekStart = searchParams.get('weekStart') // YYYY-MM-DD (Monday)
  const studentTimezone = searchParams.get('timezone')

  if (!teacherId || !weekStart) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }

  // Fail closed on the caller-supplied timezone: it is request input, not a DB
  // row, so a missing or invalid IANA value is a client bug we surface as a 400
  // rather than papering over with a guessed default.
  if (!studentTimezone) {
    return NextResponse.json({ error: 'Missing timezone parameter' }, { status: 400 })
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: studentTimezone })
  } catch {
    return NextResponse.json({ error: 'Invalid timezone parameter' }, { status: 400 })
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
  // Use the admin client so RLS on profiles/availability does not block the student's session.

  const admin = createAdminClient()

  const { data: teacherProfile, error: tzError } = await admin
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .maybeSingle()

  if (tzError) {
    return NextResponse.json({ error: 'Failed to load teacher timezone' }, { status: 500 })
  }
  if (!teacherProfile?.timezone) {
    return NextResponse.json({ error: 'Teacher not found or has no timezone set' }, { status: 404 })
  }
  const teacherTimezone = teacherProfile.timezone

  // ── Fetch availability records ──────────────────────────────────────────────

  const { data: availabilityData } = await admin
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  // Already booked lessons for this teacher this week
  const { data: bookedLessons } = await admin
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

  // NEW174: holidays block whole calendar DATES in the teacher's local frame, derived
  // from the stored date portion (YYYY-MM-DD), not the instant. This stops the
  // UTC-pinned 23:59:59+00 end from blocking one day long in UTC+ zones and closes the
  // early-hours gap on the start day. Timed 'specific' unavailability stays instant-based.
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

    // Block slots covered by timed is_available=false overrides (already UTC).
    // Holidays are excluded here - handled as whole local dates (NEW174).
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

    // NEW174: block every slot on a holiday date (whole teacher-local calendar day)
    if (holidayBlockedDates.has(dateStr)) {
      for (const slot of slots) slot.available = false
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

    // Block slots within 24 hours (24-hour booking rule) or in the past
    const now = Date.now()
    const cutoff = isAdmin ? now : now + 24 * 60 * 60 * 1000
    for (const slot of slots) {
      if (new Date(slot.startIso).getTime() < cutoff) {
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
