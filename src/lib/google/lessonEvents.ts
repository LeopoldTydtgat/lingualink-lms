// Outbound Google Calendar writes for a newly created lesson (GCAL REBUILD 2).
//
// One helper, two callers: the admin create-class route and the student
// book/reschedule route. Both are user-facing request paths that have ALREADY
// committed a lesson row and already moved hours by the time this runs, so the
// contract here is narrow and absolute: never throw, never block, never change
// what the caller returns. A Google outage must cost a calendar block, never a
// paying student's booking.
//
// CREATION ONLY. Nothing here updates or deletes an event: cancellation cleanup
// and the reschedule's old-event delete are separate commits with their own
// failure modes.
//
// Server-only. It reads google_calendar_connections through the service role
// and holds a live bearer token; nothing here may reach the browser bundle.

import { createAdminClient } from '@/lib/supabase/admin'
import { refreshGoogleAccessToken } from '@/lib/google/oauth'
import { createGoogleEvent } from '@/lib/google/calendar'

/**
 * The ONE place the block's title is built.
 *
 * FIRST NAME ONLY, deliberately. The event lands on a personal Google Calendar
 * whose notifications, widgets and shared free/busy views can surface a summary
 * far outside the platform, so the title carries the least identifying thing
 * that still tells her which class this is. Keeping it in a single function
 * means changing the wording later is a one-line change with no call sites to
 * hunt.
 *
 * The fallback covers an empty or whitespace-only name: "English class - " with
 * nothing after it reads as a bug on her calendar, and there is nothing useful
 * to log about it here.
 */
function buildLessonEventSummary(studentName: string): string {
  const firstWord = studentName.trim().split(/\s+/)[0] ?? ''
  return `English class - ${firstWord || 'Student'}`
}

/**
 * Mirrors one lesson onto the connected Google Calendar as a private
 * time-block, then stores the event id on the lesson row.
 *
 * NEVER THROWS and returns nothing: callers await it and move on without
 * branching. Every failure is a log line, because the only correct response to
 * "Google would not take the event" on a booking path is to carry on.
 */
export async function createLessonGoogleEvent(options: {
  lessonId: string
  studentName: string
  /** The lesson's scheduled_at - a UTC instant, not a local wall time. */
  scheduledAtIso: string
  durationMinutes: number
}): Promise<void> {
  const { lessonId, studentName, scheduledAtIso, durationMinutes } = options

  try {
    // Timing guard, ahead of every round trip. Both callers pass a value that
    // is already an ISO instant and a Zod-validated duration, so this is pure
    // defence in depth - but new Date(NaN).toISOString() THROWS, and without
    // this the outer catch below would swallow that only after spending a
    // token refresh on it, logging something that reads like a Google failure.
    const startMs = Date.parse(scheduledAtIso)
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0
    ) {
      console.error(
        `[google/lessonEvents] unusable timing for lesson ${lessonId}; no event created:`,
        { scheduledAtIso, durationMinutes }
      )
      return
    }

    const supabase = createAdminClient()

    // ---- 1. Which calendar --------------------------------------------------
    // public.google_calendar_connections is deny-all to anon and authenticated
    // (RLS with zero policies + REVOKE from both roles), so the service role is
    // the only role that can read it at all - this is not a convenience.
    //
    // Explicit columns, and refresh_token is the ONLY token pulled: this
    // refreshes unconditionally below, exactly like the busy-sync cron, so the
    // cached access_token has no reader here and putting it in scope would only
    // invite one. id rides along for the log lines.
    const { data: connectionRows, error: connectionError } = await supabase
      .from('google_calendar_connections')
      .select('id, refresh_token')

    if (connectionError) {
      console.error(
        `[google/lessonEvents] connection lookup failed for lesson ${lessonId}:`,
        connectionError
      )
      return
    }

    const connections = connectionRows ?? []

    // NOT A FAILURE, AND NOT WORTH A WORD. Nobody has connected a calendar,
    // which is the normal state of a platform where this feature is unused.
    // This code runs on every booking, so a log line here would be pure noise
    // in front of whoever is reading the logs for a real problem.
    if (connections.length === 0) return

    if (connections.length > 1) {
      // Single-connection model, the same rule the busy-sync cron enforces.
      // More than one row means the model moved and this helper would have to
      // GUESS whose calendar a given class belongs on. Refuse rather than
      // guess: a missing block is recoverable at any time, a class written onto
      // the wrong person's personal calendar is not.
      console.error(
        `[google/lessonEvents] expected at most 1 Google Calendar connection, found ${connections.length}; no event created for lesson ${lessonId}`
      )
      return
    }

    const connection = connections[0]
    const refreshToken = connection.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
      console.error(
        `[google/lessonEvents] connection ${connection.id} carries no refresh token; no event created for lesson ${lessonId}`
      )
      return
    }

    // ---- 2. Token -----------------------------------------------------------
    const refresh = await refreshGoogleAccessToken(refreshToken)

    // Every non-'refreshed' outcome ends here, INCLUDING 'revoked', and
    // DELIBERATELY WITHOUT WRITING ANY settings KEY. The busy-sync cron is the
    // single writer of google_busy_sync_failures / _last_error / _revoked, and
    // those keys drive the admin's sync-health banner. A second writer sitting
    // on the booking path would march the consecutive-failure counter on
    // traffic the cron never saw, so the banner would describe a sync state
    // that never happened. The cron re-discovers a revoked grant on its own
    // within 15 minutes, which is what that banner is for.
    if (refresh.outcome !== 'refreshed' || !refresh.accessToken) {
      console.error(
        `[google/lessonEvents] token refresh returned '${refresh.outcome}' for lesson ${lessonId}: ${refresh.error ?? 'unknown error'}`
      )
      return
    }

    // ---- 3. The event -------------------------------------------------------
    // No attendees, no sendUpdates, no reminders - createGoogleEvent sends a
    // fixed three-field body and nothing may be added here that could
    // reintroduce them. This is a private block on one person's own calendar,
    // never an invitation; meeting invites belong to the Teams integration and
    // go out under the platform organiser account.
    const created = await createGoogleEvent({
      accessToken: refresh.accessToken,
      summary: buildLessonEventSummary(studentName),
      // Both edges re-serialised from the parsed epoch ms, so Google receives
      // RFC3339-with-Z whatever shape the caller passed in.
      //
      // toISOString here is NOT the banned pattern: the ban is on building a
      // LOCAL calendar date out of it. scheduled_at is a UTC instant and this
      // sends it as a UTC instant - the same call the busy-sync cron makes for
      // its timeMin/timeMax.
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + durationMinutes * 60 * 1000).toISOString(),
      // 'UTC' is deliberate and is NOT a claim about anybody's timezone. Google
      // treats the offset inside an RFC3339 dateTime as authoritative and falls
      // back to timeZone only for recurring events, which these are not - so
      // the instant is already pinned by the 'Z' above, and her calendar
      // renders it in her own local time no matter what is sent here.
      timezone: 'UTC',
    })

    if (!created.ok) {
      // createGoogleEvent has already logged the HTTP status and Google's own
      // message; this line is what ties that to a lesson.
      console.error(
        `[google/lessonEvents] event create failed for lesson ${lessonId}: ${created.error}`
      )
      return
    }

    // ---- 4. The pointer -----------------------------------------------------
    // The event id is the ONLY handle on the block. Service role: lessons
    // grants INSERT/UPDATE to service_role and postgres only.
    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({ google_event_id: created.eventId })
      .eq('id', lessonId)
      .select('id')

    if (updateError) {
      // The event EXISTS on her calendar and nothing in the database points at
      // it, so no cancellation or reschedule cleanup can ever find it. This log
      // line is the only pointer that exists - it must name both ids.
      console.error(
        'CRITICAL: orphaned Google Calendar event - created but the lesson pointer could not be written:',
        { google_event_id: created.eventId, lesson_id: lessonId, error: updateError }
      )
      return
    }

    if (!updated || updated.length === 0) {
      // Same orphan, different cause: the UPDATE ran but matched no row (the
      // lesson was deleted from under us). Nothing to self-heal against, so
      // again the log is the only record.
      console.error(
        'CRITICAL: orphaned Google Calendar event - the lesson pointer UPDATE matched 0 rows:',
        { google_event_id: created.eventId, lesson_id: lessonId }
      )
    }
  } catch (unexpected) {
    // The outer guarantee. Anything unforeseen in here dies quietly rather than
    // reaching a caller whose lesson is already committed and whose hours have
    // already moved.
    console.error(
      `[google/lessonEvents] unexpected failure while creating the event for lesson ${lessonId}:`,
      unexpected
    )
  }
}
