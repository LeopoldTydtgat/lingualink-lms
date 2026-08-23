// Outbound Google Calendar writes for one lesson (GCAL REBUILD 2).
//
// Two helpers, five callers: the admin create-class route and the student
// book/reschedule route mirror a new lesson onto the calendar; the teacher,
// student and admin cancel paths take it back off. Every one of them is a
// user-facing request path that has ALREADY committed the lesson row and
// already moved hours by the time this runs, so the contract here is narrow and
// absolute: never throw, never block, never change what the caller returns. A
// Google outage must cost a calendar block, never a paying student's booking
// and never a cancellation.
//
// CREATE AND DELETE ONLY. Nothing here MOVES an event: the reschedule's
// old-event update is a separate commit with its own failure modes.
//
// Server-only. It reads google_calendar_connections through the service role
// and holds a live bearer token; nothing here may reach the browser bundle.

import { createAdminClient } from '@/lib/supabase/admin'
import { refreshGoogleAccessToken } from '@/lib/google/oauth'
import { createGoogleEvent, deleteGoogleEvent } from '@/lib/google/calendar'

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
 * A live bearer token for the one connected calendar, or null when there is
 * nothing to write to.
 *
 * The ONE place the connection is resolved, so the create and delete helpers
 * can never disagree about whose calendar a lesson belongs on. Never throws:
 * every null is either already logged here or a deliberate silence, and the
 * caller's only correct response to any of them is to return.
 *
 * `lessonId` is carried in purely so every line logged from here names the
 * lesson that provoked it.
 */
async function resolveGoogleAccessToken(lessonId: string): Promise<string | null> {
  const supabase = createAdminClient()

  // ---- 1. Which calendar ----------------------------------------------------
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
    return null
  }

  const connections = connectionRows ?? []

  // NOT A FAILURE, AND NOT WORTH A WORD. Nobody has connected a calendar,
  // which is the normal state of a platform where this feature is unused.
  // This code runs on every booking, so a log line here would be pure noise
  // in front of whoever is reading the logs for a real problem.
  if (connections.length === 0) return null

  if (connections.length > 1) {
    // Single-connection model, the same rule the busy-sync cron enforces.
    // More than one row means the model moved and this helper would have to
    // GUESS whose calendar a given class belongs on. Refuse rather than
    // guess: a missing block is recoverable at any time, a class written onto
    // the wrong person's personal calendar is not.
    console.error(
      `[google/lessonEvents] expected at most 1 Google Calendar connection, found ${connections.length}; no calendar write for lesson ${lessonId}`
    )
    return null
  }

  const connection = connections[0]
  const refreshToken = connection.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    console.error(
      `[google/lessonEvents] connection ${connection.id} carries no refresh token; no calendar write for lesson ${lessonId}`
    )
    return null
  }

  // ---- 2. Token -------------------------------------------------------------
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
    return null
  }

  return refresh.accessToken
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

    const accessToken = await resolveGoogleAccessToken(lessonId)
    if (!accessToken) return

    // ---- 3. The event -------------------------------------------------------
    // No attendees, no sendUpdates, no reminders - createGoogleEvent sends a
    // fixed three-field body and nothing may be added here that could
    // reintroduce them. This is a private block on one person's own calendar,
    // never an invitation; meeting invites belong to the Teams integration and
    // go out under the platform organiser account.
    const created = await createGoogleEvent({
      accessToken,
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
    const supabase = createAdminClient()
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

/**
 * Takes the Google Calendar block for a cancelled lesson back off the calendar,
 * then clears the pointer that named it.
 *
 * Same contract as createLessonGoogleEvent, deliberately: NEVER THROWS, returns
 * nothing, and the three cancel paths call it without branching. By the time
 * this runs cancel_lesson_atomic has already committed and any refund has
 * already moved, so a Google outage must cost a stale calendar block and
 * nothing else.
 */
export async function deleteLessonGoogleEvent(lessonId: string): Promise<void> {
  try {
    const supabase = createAdminClient()

    // ---- 1. Is there anything to delete -------------------------------------
    // Explicit columns. google_event_id is the only handle that exists; id
    // rides along so a missing row is distinguishable from a null pointer.
    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('id, google_event_id')
      .eq('id', lessonId)
      .maybeSingle()

    if (lessonError) {
      console.error(
        `[google/lessonEvents] lesson lookup failed for lesson ${lessonId}; any Google event was left on the calendar:`,
        lessonError
      )
      return
    }

    if (!lesson) {
      // Genuinely anomalous, and worth a line. Every caller reaches here
      // immediately after cancel_lesson_atomic reported success on this exact
      // id, so the row existed moments ago; something deleted it from under us
      // and took the only pointer to the calendar block with it.
      console.error(
        `[google/lessonEvents] no lesson row for ${lessonId} straight after a successful cancel; any Google event is now unreachable`
      )
      return
    }

    const eventId = lesson.google_event_id
    // NOT A FAILURE, AND NOT WORTH A WORD. This is the normal state for every
    // lesson booked before this feature existed and every booking made while no
    // calendar was connected. It runs on every cancellation, so a log line here
    // would be pure noise in front of whoever is reading the logs for a real
    // problem.
    if (typeof eventId !== 'string' || eventId.trim().length === 0) return

    const accessToken = await resolveGoogleAccessToken(lessonId)
    if (!accessToken) return

    // ---- 2. The delete ------------------------------------------------------
    // deleteGoogleEvent already treats 404 and 410 as success, so an event that
    // is ALREADY gone from her calendar takes the ok branch below and clears the
    // pointer, rather than stranding a dead id on the lesson forever.
    const deleted = await deleteGoogleEvent({ accessToken, eventId })

    if (!deleted.ok) {
      // The pointer is DELIBERATELY LEFT IN PLACE. The block is still sitting on
      // her calendar and this id is the only way anything will ever find it
      // again; nulling it here would make the stale block permanently
      // unreachable. Same reasoning as the Teams teardown, which keeps
      // teams_meeting_id on a failed Graph call so the sweeper can still find
      // the meeting.
      console.error(
        `[google/lessonEvents] event delete failed for lesson ${lessonId} (google_event_id ${eventId}); the pointer is kept so the stale block stays findable: ${deleted.error}`
      )
      return
    }

    // ---- 3. The pointer -----------------------------------------------------
    // Only once Google has confirmed the block is gone. Service role: lessons
    // grants INSERT/UPDATE to service_role and postgres only.
    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({ google_event_id: null })
      .eq('id', lessonId)
      .select('id')

    if (updateError) {
      // The block is gone but the lesson still names it. Harmless to the
      // calendar, and self-healing on any later delete (404 counts as success),
      // but it leaves a dead id on the row - so it is logged with both ids.
      console.error(
        'CRITICAL: Google Calendar event deleted but the lesson pointer could not be cleared:',
        { google_event_id: eventId, lesson_id: lessonId, error: updateError }
      )
      return
    }

    if (!updated || updated.length === 0) {
      // Same stale pointer, different cause: the UPDATE ran but matched no row
      // (the lesson was deleted from under us between the read above and here).
      console.error(
        'CRITICAL: Google Calendar event deleted but the pointer UPDATE matched 0 rows:',
        { google_event_id: eventId, lesson_id: lessonId }
      )
    }
  } catch (unexpected) {
    // The outer guarantee, exactly as on the create path. Anything unforeseen
    // dies quietly rather than reaching a caller whose lesson is already
    // cancelled and whose refund has already moved.
    console.error(
      `[google/lessonEvents] unexpected failure while deleting the event for lesson ${lessonId}:`,
      unexpected
    )
  }
}
