import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  buildWeekSlots,
  getWeekWindow,
  MAX_LESSON_MS,
  type AvailabilityRecord,
  type BookedLesson,
} from './slotEngine'

// ─── Main handler ─────────────────────────────────────────────────────────────
//
// NEW317: all slot generation, blocking and bucketing lives in ./slotEngine
// (pure + unit-tested). This handler only does auth, param validation and the
// two DB reads, then hands the rows to the engine.

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
  // YYYY-MM-DD — a calendar date in the DISPLAY timezone below (Monday for the
  // student booking grid; any weekday for the admin single-date flows).
  const weekStart = searchParams.get('weekStart')
  // The timezone the response keys are expressed in: the student's profile tz
  // for the student flow, the teacher's tz for the admin flows.
  const displayTimezone = searchParams.get('timezone')

  if (!teacherId || !weekStart) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }
  // localToUtc requires a well-formed date; fail closed instead of throwing.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'Invalid weekStart parameter' }, { status: 400 })
  }

  // Fail closed on the caller-supplied timezone: it is request input, not a DB
  // row, so a missing or invalid IANA value is a client bug we surface as a 400
  // rather than papering over with a guessed default.
  if (!displayTimezone) {
    return NextResponse.json({ error: 'Missing timezone parameter' }, { status: 400 })
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: displayTimezone })
  } catch {
    return NextResponse.json({ error: 'Invalid timezone parameter' }, { status: 400 })
  }

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

  // NEW317: the week is [weekStart 00:00, weekStart+7d 00:00) in the display
  // timezone, resolved to true UTC instants.
  const { windowStartMs, windowEndMs } = getWeekWindow(weekStart, displayTimezone)

  // ── Fetch availability records ──────────────────────────────────────────────

  const { data: availabilityData } = await admin
    .from('availability')
    .select('type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', teacherId)

  // Already booked lessons overlapping this week's instant window. The lower
  // bound is widened by the longest lesson duration so a lesson that starts
  // just before the window still blocks the slots it overlaps inside it.
  const { data: bookedLessons } = await admin
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', teacherId)
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date(windowStartMs - MAX_LESSON_MS).toISOString())
    .lt('scheduled_at', new Date(windowEndMs).toISOString())

  const records: AvailabilityRecord[] = availabilityData ?? []
  const booked: BookedLesson[] = bookedLessons ?? []

  const slotsByDate = buildWeekSlots({
    weekStart,
    displayTimezone,
    teacherTimezone,
    records,
    booked,
    nowMs: Date.now(),
    isAdmin: Boolean(isAdmin),
  })

  return NextResponse.json({ slots: slotsByDate })
}
