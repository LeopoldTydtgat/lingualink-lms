import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildIcsCalendar } from '@/lib/ics'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'

// GET /api/calendar-feed/[token]
//
// PUBLIC route. Calendar apps (Google Calendar, Outlook, Apple Calendar) poll
// this URL on their own schedule with no cookies, so it is the one /api/ path
// exempted from the session gate in src/proxy.ts. The opaque token in the path
// IS the authentication: it is minted server-side only (crypto.randomBytes) by
// /api/calendar-subscription/token, is never accepted from a client, and is
// revoked by rotating that row.
//
// Every outcome that could confirm or deny the existence of an account returns
// the SAME bare 404 body: a malformed token, an unknown token, a deleted owner
// and an inactive owner are indistinguishable from outside. Only genuine
// infrastructure failures return 500, and never with the Postgres message.
//
// public.calendar_feed_tokens has RLS enabled with zero policies and is REVOKEd
// from anon + authenticated, so it is reachable only through the service-role
// client. Every touch of it below therefore uses createAdminClient().

const ROUTE = '[GET /api/calendar-feed/[token]]'

// A subscription feed that gets cached goes silently stale and stops reflecting
// new bookings and cancellations, which is the exact failure this feature
// exists to avoid.
export const dynamic = 'force-dynamic'

// base64url alphabet only. Wide enough for the 43-character tokens the issuing
// route mints from 32 random bytes, and narrow enough that nothing reaches
// Postgres that a text comparison would have to interpret.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// Owner statuses that must not be served a feed. Mirrors the account gate in
// src/proxy.ts, where a missing record, 'former', or 'on_hold' all block; a
// null status is not a block there and is not one here.
const BLOCKED_OWNER_STATUSES = new Set(['former', 'on_hold'])

// Only reached if a lesson row carries no usable duration. Dropping the class
// would silently remove it from a calendar the user is subscribed to, which is
// worse than an approximate end time, so the class is kept and the data anomaly
// is logged server-side instead.
const FALLBACK_DURATION_MINUTES = 60

// The feed reaches 30 days into the past so a freshly subscribed calendar shows
// recent history. There is deliberately no upper bound: the calendar app should
// see every future class, however far out it is booked.
const WINDOW_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

interface FeedLesson {
  id: string
  scheduled_at: string | null
  duration_minutes: number | null
  counterpartName: string | null
}

// Supabase returns an embedded relation as either an object or a single-element
// array depending on how it resolves the join, which is why every read site in
// this project flattens with an Array.isArray check.
type Embedded = { full_name: string | null } | { full_name: string | null }[] | null

interface TeacherLessonRow {
  id: string
  scheduled_at: string | null
  duration_minutes: number | null
  students: Embedded
}

interface StudentLessonRow {
  id: string
  scheduled_at: string | null
  duration_minutes: number | null
  teacher: Embedded
}

interface IcsEventInput {
  uid: string
  startIso: string
  endIso: string
  summary: string
  description: string
}

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function serverError() {
  return new NextResponse('Unable to build calendar feed', {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      return notFound()
    }

    const admin = createAdminClient()

    // -- 1. Resolve the token -------------------------------------------------
    const { data: tokenRow, error: tokenError } = await admin
      .from('calendar_feed_tokens')
      .select('user_type, user_id')
      .eq('token', token)
      .maybeSingle()

    if (tokenError) {
      console.error(`${ROUTE} token lookup failed:`, tokenError)
      return serverError()
    }
    if (!tokenRow) return notFound()

    const userType = tokenRow.user_type
    const userId = tokenRow.user_id

    // The table has a CHECK on user_type, so this is a corrupt-row guard rather
    // than an expected branch. It must not leak that the token itself resolved.
    if (
      (userType !== 'teacher' && userType !== 'student') ||
      typeof userId !== 'string' ||
      userId.length === 0
    ) {
      console.error(`${ROUTE} token row has an unusable owner reference:`, { userType })
      return notFound()
    }

    // -- 2. Owner status gate -------------------------------------------------
    // Token rows store profiles.id for teachers and students.id (the students
    // table PK, never the auth uuid) for students - see the issuing route at
    // /api/calendar-subscription/token, and lessons.student_id, which keys on
    // the same PK.
    let ownerExists = false
    let ownerStatus: string | null = null

    if (userType === 'teacher') {
      const { data: owner, error: ownerError } = await admin
        .from('profiles')
        .select('status')
        .eq('id', userId)
        .maybeSingle()

      if (ownerError) {
        console.error(`${ROUTE} teacher owner lookup failed:`, ownerError)
        return serverError()
      }
      if (owner) {
        ownerExists = true
        ownerStatus = owner.status ?? null
      }
    } else {
      const { data: owner, error: ownerError } = await admin
        .from('students')
        .select('status')
        .eq('id', userId)
        .maybeSingle()

      if (ownerError) {
        console.error(`${ROUTE} student owner lookup failed:`, ownerError)
        return serverError()
      }
      if (owner) {
        ownerExists = true
        ownerStatus = owner.status ?? null
      }
    }

    if (!ownerExists || BLOCKED_OWNER_STATUSES.has(ownerStatus ?? '')) {
      return notFound()
    }

    // -- 3. Lessons -----------------------------------------------------------
    // Instant arithmetic against a UTC timestamptz column. No local date is
    // constructed anywhere in this route.
    const windowStartIso = new Date(Date.now() - WINDOW_LOOKBACK_MS).toISOString()
    const excludedStatuses = toPostgrestInList(CANCELLED_STATUSES)

    let lessons: FeedLesson[] = []

    if (userType === 'teacher') {
      const { data, error } = await admin
        .from('lessons')
        .select('id, scheduled_at, duration_minutes, students ( full_name )')
        .eq('teacher_id', userId)
        .gte('scheduled_at', windowStartIso)
        .not('status', 'in', excludedStatuses)
        .order('scheduled_at', { ascending: true })

      if (error) {
        console.error(`${ROUTE} teacher lessons query failed:`, error)
        return serverError()
      }

      lessons = ((data ?? []) as TeacherLessonRow[]).map((row) => {
        const student = Array.isArray(row.students) ? row.students[0] : row.students
        return {
          id: row.id,
          scheduled_at: row.scheduled_at,
          duration_minutes: row.duration_minutes,
          counterpartName: student?.full_name ?? null,
        }
      })
    } else {
      const { data, error } = await admin
        .from('lessons')
        .select('id, scheduled_at, duration_minutes, teacher:profiles!teacher_id ( full_name )')
        .eq('student_id', userId)
        .gte('scheduled_at', windowStartIso)
        .not('status', 'in', excludedStatuses)
        .order('scheduled_at', { ascending: true })

      if (error) {
        console.error(`${ROUTE} student lessons query failed:`, error)
        return serverError()
      }

      lessons = ((data ?? []) as StudentLessonRow[]).map((row) => {
        const teacher = Array.isArray(row.teacher) ? row.teacher[0] : row.teacher
        return {
          id: row.id,
          scheduled_at: row.scheduled_at,
          duration_minutes: row.duration_minutes,
          counterpartName: teacher?.full_name ?? null,
        }
      })
    }

    // -- 4. Build the calendar ------------------------------------------------
    const fallbackName = userType === 'teacher' ? 'Unknown student' : 'Unknown teacher'
    const events: IcsEventInput[] = []

    for (const lesson of lessons) {
      if (!lesson.scheduled_at) {
        console.error(`${ROUTE} lesson has no scheduled_at, skipped:`, lesson.id)
        continue
      }

      const startMs = new Date(lesson.scheduled_at).getTime()
      if (!Number.isFinite(startMs)) {
        console.error(`${ROUTE} lesson has an unparsable scheduled_at, skipped:`, lesson.id)
        continue
      }

      let durationMinutes = lesson.duration_minutes
      if (
        typeof durationMinutes !== 'number' ||
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0
      ) {
        console.error(
          `${ROUTE} lesson has no usable duration_minutes, falling back to ${FALLBACK_DURATION_MINUTES}:`,
          lesson.id
        )
        durationMinutes = FALLBACK_DURATION_MINUTES
      }

      const name = lesson.counterpartName ?? fallbackName

      events.push({
        uid: `${lesson.id}@lingualinkonline.com`,
        startIso: lesson.scheduled_at,
        // Instant math on a UTC instant, back out as a UTC instant. This is the
        // permitted use of toISOString - it never builds a local date.
        endIso: new Date(startMs + durationMinutes * 60_000).toISOString(),
        summary: name,
        description: `Class with ${name}`,
      })
    }

    // An empty list still yields a valid, empty VCALENDAR - the correct answer
    // for a user with no classes in the window, and one calendar apps accept.
    return new NextResponse(buildIcsCalendar(events), {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (err) {
    console.error(`${ROUTE} unexpected error:`, err)
    return serverError()
  }
}
