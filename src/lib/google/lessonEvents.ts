// Outbound Google Calendar writes for one lesson (GCAL REBUILD 2).
//
// Three helpers, seven call sites: the admin create-class route and the student
// book/reschedule route mirror a new lesson onto the calendar; the teacher,
// student and admin cancel paths - plus the student reschedule, taking the old
// row's block off - clear it again; the admin class edit moves it. Every one of
// them is a user-facing request path that has ALREADY committed the lesson row
// and already moved hours by the time this runs, so the contract here is narrow
// and absolute: never throw, never block, never change what the caller returns.
// A Google outage must cost a calendar block, never a paying student's booking
// and never a cancellation.
//
// CREATE, UPDATE AND DELETE. The update moves an existing block onto a new time
// and writes a missing one; nothing here ever moves an event BETWEEN lessons -
// every helper works only on the id stored on the lesson row it was handed.
//
// Server-only. It reads google_calendar_connections through the service role
// and holds a live bearer token; nothing here may reach the browser bundle.

import { createAdminClient } from '@/lib/supabase/admin'
import { refreshGoogleAccessToken } from '@/lib/google/oauth'
import { createGoogleEvent, deleteGoogleEvent, updateGoogleEvent } from '@/lib/google/calendar'

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
 * A live bearer token for the calendar connected by THE LESSON'S OWN TEACHER,
 * or null when there is nothing to write to.
 *
 * The ONE place the connection is resolved, so the create, update and delete
 * helpers can never disagree about whose calendar a lesson belongs on. The
 * lookup is FILTERED ON THAT TEACHER'S profile_id, and that filter is what
 * makes a class taught by anybody else structurally incapable of reaching her
 * calendar: without it a single connected account would collect the blocks of
 * every teacher on the platform.
 *
 * Never throws: every null is either already logged here or a deliberate
 * silence, and the caller's only correct response to any of them is to return.
 *
 * `lessonId` is carried in purely so every line logged from here names the
 * lesson that provoked it.
 */
async function resolveGoogleAccessToken(
  teacherId: string,
  lessonId: string
): Promise<string | null> {
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
  //
  // The profile_id filter is the ownership guarantee. It is not a narrowing of
  // a broader query - it IS the rule, and there is no second check anywhere
  // downstream.
  const { data: connectionRows, error: connectionError } = await supabase
    .from('google_calendar_connections')
    .select('id, refresh_token')
    .eq('profile_id', teacherId)

  if (connectionError) {
    console.error(
      `[google/lessonEvents] connection lookup failed for lesson ${lessonId}:`,
      connectionError
    )
    return null
  }

  const connections = connectionRows ?? []

  // NOT A FAILURE, AND NOT WORTH A WORD. This lesson's teacher has not
  // connected a calendar, which is the normal state for every teacher on a
  // platform where one person uses the feature - so this branch is now the
  // COMMON case, not the empty-platform case it used to be.
  //
  // It is also the whole ownership rule, stated as behaviour: a lesson whose
  // own teacher has no connection row must never touch ANYBODY's calendar.
  // Falling back to "the one connection that exists" is exactly the defect the
  // filter above removes. This code runs on every booking, cancellation and
  // edit, so a log line here would be pure noise in front of whoever is reading
  // the logs for a real problem.
  if (connections.length === 0) return null

  if (connections.length > 1) {
    // One connection per teacher, the same single-connection model the
    // busy-sync cron enforces. More than one row FOR THIS ONE PROFILE means the
    // model moved and this helper would have to GUESS which of her calendars a
    // given class belongs on. Refuse rather than guess: a missing block is
    // recoverable at any time, a class written onto the wrong calendar is not.
    console.error(
      `[google/lessonEvents] expected at most 1 Google Calendar connection for profile ${teacherId}, found ${connections.length}; no calendar write for lesson ${lessonId}`
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
 * Writes a freshly created event's id onto the lesson row.
 *
 * The ONE place the pointer is set, shared by createLessonGoogleEvent and the
 * create-if-missing branch of updateLessonGoogleEvent, so the two can never
 * disagree about what an orphan is or how it is reported.
 *
 * The event id is the ONLY handle on the block. Service role: lessons grants
 * INSERT/UPDATE to service_role and postgres only.
 *
 * Never throws on its own account, and both callers hold it inside their outer
 * catch regardless. Every failure here is a CRITICAL line naming both ids.
 */
async function writeLessonEventPointer(
  supabase: ReturnType<typeof createAdminClient>,
  lessonId: string,
  eventId: string
): Promise<void> {
  const { data: updated, error: updateError } = await supabase
    .from('lessons')
    .update({ google_event_id: eventId })
    .eq('id', lessonId)
    .select('id')

  if (updateError) {
    // The event EXISTS on her calendar and nothing in the database points at
    // it, so no cancellation or reschedule cleanup can ever find it. This log
    // line is the only pointer that exists - it must name both ids.
    console.error(
      'CRITICAL: orphaned Google Calendar event - created but the lesson pointer could not be written:',
      { google_event_id: eventId, lesson_id: lessonId, error: updateError }
    )
    return
  }

  if (!updated || updated.length === 0) {
    // Same orphan, different cause: the UPDATE ran but matched no row (the
    // lesson was deleted from under us). Nothing to self-heal against, so
    // again the log is the only record.
    console.error(
      'CRITICAL: orphaned Google Calendar event - the lesson pointer UPDATE matched 0 rows:',
      { google_event_id: eventId, lesson_id: lessonId }
    )
  }
}

/**
 * Mirrors one lesson onto its own teacher's connected Google Calendar as a
 * private time-block, then stores the event id on the lesson row.
 *
 * NEVER THROWS and returns nothing: callers await it and move on without
 * branching. Every failure is a log line, because the only correct response to
 * "Google would not take the event" on a booking path is to carry on.
 */
export async function createLessonGoogleEvent(options: {
  lessonId: string
  /**
   * The lesson's teacher. The ONLY calendar this block may ever land on: if
   * that teacher has no connection row, nothing is written at all.
   */
  teacherId: string
  studentName: string
  /** The lesson's scheduled_at - a UTC instant, not a local wall time. */
  scheduledAtIso: string
  durationMinutes: number
}): Promise<void> {
  const { lessonId, teacherId, studentName, scheduledAtIso, durationMinutes } = options

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

    const accessToken = await resolveGoogleAccessToken(teacherId, lessonId)
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
    await writeLessonEventPointer(createAdminClient(), lessonId, created.eventId)
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
 * Moves the Google Calendar block for an edited lesson onto its new time, puts
 * one there if the lesson has never had one, and - when the edit handed the
 * class to a different teacher - moves the block off the outgoing teacher's
 * calendar and onto the new one's.
 *
 * Same contract as its two siblings: NEVER THROWS, returns nothing, and the
 * admin edit route calls it without branching. By the time this runs
 * admin_edit_lesson_atomic has already committed the new time, duration and
 * teacher, so a Google outage must cost a block left at the old time - or left
 * on the old teacher's calendar - and nothing else.
 *
 * The title is built ONLY where an event is created. updateGoogleEvent
 * deliberately never resends a summary, so a block she has renamed on her own
 * calendar keeps her wording through every edit.
 */
export async function updateLessonGoogleEvent(options: {
  lessonId: string
  studentName: string
  /** The lesson's NEW scheduled_at - a UTC instant, not a local wall time. */
  scheduledAtIso: string
  durationMinutes: number
  /**
   * The teacher this lesson belonged to BEFORE the edit, and ONLY when the edit
   * actually reassigned it. Absent - or equal to the row's current teacher_id -
   * means no swap, and this helper behaves exactly as it always has.
   */
  previousTeacherId?: string
}): Promise<void> {
  const { lessonId, studentName, scheduledAtIso, durationMinutes, previousTeacherId } = options

  try {
    // The create path's timing guard, unchanged and for the same reason: the
    // caller passes an ISO instant and a Zod-validated duration, so this is
    // defence in depth - but new Date(NaN).toISOString() THROWS, and without it
    // the outer catch below would swallow that only after spending a database
    // read and a token refresh on it.
    const startMs = Date.parse(scheduledAtIso)
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0
    ) {
      console.error(
        `[google/lessonEvents] unusable timing for lesson ${lessonId}; no event moved:`,
        { scheduledAtIso, durationMinutes }
      )
      return
    }

    const supabase = createAdminClient()

    // ---- 1. Is there a block to move, and whose is it -----------------------
    // Explicit columns, the same read the delete path makes. The admin edit
    // MUTATES the lesson in place rather than replacing it, so a google_event_id
    // written at booking time is still on this row and still names the right
    // event. teacher_id rides along because it decides WHICH calendar the block
    // belongs on - and on a swap it has already been updated to the new owner
    // by admin_edit_lesson_atomic.
    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('id, teacher_id, google_event_id')
      .eq('id', lessonId)
      .maybeSingle()

    if (lessonError) {
      console.error(
        `[google/lessonEvents] lesson lookup failed for lesson ${lessonId}; any Google event was left at its old time:`,
        lessonError
      )
      return
    }

    if (!lesson) {
      // Genuinely anomalous, and worth a line. The caller reaches here
      // immediately after admin_edit_lesson_atomic reported success on this
      // exact id, so the row existed moments ago; something deleted it from
      // under us and took the only pointer to the calendar block with it.
      console.error(
        `[google/lessonEvents] no lesson row for ${lessonId} straight after a successful edit; any Google event is now unreachable`
      )
      return
    }

    // CAPTURED BEFORE ANY BRANCH, and load-bearing on the swap path below: the
    // new owner's create OVERWRITES google_event_id on this row, so after that
    // point this local is the only thing left that knows which event has to
    // come off the OLD owner's calendar.
    const inheritedEventId = lesson.google_event_id

    // The lesson's CURRENT teacher - already the new one on a swap.
    const currentTeacherId = lesson.teacher_id
    if (typeof currentTeacherId !== 'string' || currentTeacherId.trim().length === 0) {
      // Anomalous: lessons.teacher_id is NOT NULL. Without it there is no
      // calendar to resolve at all, so nothing is touched and this line is the
      // only record of why.
      console.error(
        `[google/lessonEvents] lesson ${lessonId} carries no teacher_id; no calendar was touched for this edit`
      )
      return
    }

    // Both edges re-serialised from the parsed epoch ms, exactly as on the
    // create path, so Google receives RFC3339-with-Z whichever branch runs.
    const startIso = new Date(startMs).toISOString()
    const endIso = new Date(startMs + durationMinutes * 60 * 1000).toISOString()

    // Trimmed once into a plain string, so the swap test below and every later
    // use read the same value.
    const previousOwnerId =
      typeof previousTeacherId === 'string' ? previousTeacherId.trim() : ''
    const swappedTeacher = previousOwnerId.length > 0 && previousOwnerId !== currentTeacherId

    if (!swappedTeacher) {
      // ---- 2. Same teacher: move the block, or put one there ----------------
      // Resolved ONCE, above the branch. Both halves below need a bearer token
      // and neither may spend a second refresh on the same request.
      const accessToken = await resolveGoogleAccessToken(currentTeacherId, lessonId)
      if (!accessToken) return

      const eventId = inheritedEventId
      if (typeof eventId === 'string' && eventId.trim().length > 0) {
        // start and end only - see updateGoogleEvent. 'UTC' means here exactly
        // what it means on the create path and is NOT a claim about anybody's
        // timezone: the 'Z' above already pins the instant, and her calendar
        // renders it in her own local time no matter what is sent.
        const moved = await updateGoogleEvent({
          accessToken,
          eventId,
          startIso,
          endIso,
          timezone: 'UTC',
        })

        if (!moved.ok) {
          // The pointer is DELIBERATELY LEFT IN PLACE, same rule as the delete
          // path. The event still EXISTS, at its old time, and this id is the
          // only handle on it; clearing it here would strand a block that now
          // contradicts the lesson with nothing left to find it by. A later edit
          // or the cancellation will try again against the same id.
          console.error(
            `[google/lessonEvents] event update failed for lesson ${lessonId} (google_event_id ${eventId}); the block is still at its old time and the pointer is kept: ${moved.error}`
          )
        }

        // Nothing to write on the success path either: the event id has not
        // changed, so the row already says everything true about the block.
        return
      }

      // ---- 3. Create if missing ---------------------------------------------
      // No pointer on the row: either the lesson predates the column or its
      // create failed at booking time. An edit is the natural moment to put the
      // block on the calendar rather than leave the class invisible on it for
      // good. The title comes from the one builder above, so a block written
      // here is indistinguishable from one written at booking - and, exactly as
      // there, no attendees and no reminders may ever be added to this call.
      const created = await createGoogleEvent({
        accessToken,
        summary: buildLessonEventSummary(studentName),
        startIso,
        endIso,
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

      // ---- 4. The pointer ---------------------------------------------------
      await writeLessonEventPointer(supabase, lessonId, created.eventId)
      return
    }

    // ---- 5. The class changed hands -----------------------------------------
    // CREATE FIRST, DELETE SECOND, and the order is load-bearing - the same rule
    // the student reschedule follows. Taking the old block off first and then
    // failing the create would leave the class with no block on anybody's
    // calendar, which is precisely the invisible-class failure this rebuild
    // exists to remove; this way round a failed create leaves a visible stale
    // block on the old owner's calendar instead, which she can see and which is
    // recoverable at any time.
    //
    // Step 1 OVERWRITES google_event_id with the new owner's event, which is
    // exactly why inheritedEventId was captured above the branch: the old
    // event's only handle is held in memory across that overwrite, so the
    // pointer swap can never orphan it.
    //
    // This runs because OWNERSHIP changed, not to resend a title. The block
    // itself is unchanged - buildLessonEventSummary is the student's first name
    // and nothing else - but it is now on the wrong person's calendar.
    let newPointerWritten = false

    const newOwnerToken = await resolveGoogleAccessToken(currentTeacherId, lessonId)
    if (newOwnerToken) {
      // A fresh block for the new owner, at the times this edit committed. No
      // attendees and no reminders, exactly as everywhere else in this file.
      const created = await createGoogleEvent({
        accessToken: newOwnerToken,
        summary: buildLessonEventSummary(studentName),
        startIso,
        endIso,
        timezone: 'UTC',
      })

      if (created.ok) {
        await writeLessonEventPointer(supabase, lessonId, created.eventId)
        newPointerWritten = true
      } else {
        // createGoogleEvent has already logged the HTTP status and Google's own
        // message; this line is what ties that to a lesson.
        console.error(
          `[google/lessonEvents] event create failed for lesson ${lessonId}: ${created.error}`
        )
      }
    }
    // No token for the new owner is SILENT: she has simply not connected a
    // calendar, which resolveGoogleAccessToken has already decided is the normal
    // case. The old owner's block still has to come off below regardless - a
    // class she no longer teaches must not stay on her calendar just because her
    // replacement does not use the integration.

    // Nothing was ever on the old owner's calendar, so the swap is finished.
    if (typeof inheritedEventId !== 'string' || inheritedEventId.trim().length === 0) return

    const previousOwnerToken = await resolveGoogleAccessToken(previousOwnerId, lessonId)
    if (!previousOwnerToken) {
      // NOTHING can delete that event now: the id is only meaningful against the
      // account it was created on, and there is no token for it any more. Error
      // level, naming all three identifiers, so the stranded block is findable
      // by hand - this is the one failure here with no self-healing path.
      console.error(
        `[google/lessonEvents] no Google connection for the previous teacher of lesson ${lessonId}; google_event_id ${inheritedEventId} is stranded on the calendar of profile ${previousOwnerId}`
      )
      return
    }

    // DELIBERATELY NOT deleteLessonGoogleEvent. That helper re-reads the pointer
    // off the row, which step 1 may already have replaced with the NEW owner's
    // event id - it would delete the block this edit has just created, on the
    // wrong calendar. The id goes in directly, from memory.
    //
    // deleteGoogleEvent already treats 404 and 410 as success, so an event that
    // is ALREADY gone from her calendar takes the ok branch below.
    const deleted = await deleteGoogleEvent({
      accessToken: previousOwnerToken,
      eventId: inheritedEventId,
    })

    if (!deleted.ok) {
      // The pointer is left exactly as it stands - either still naming this
      // stale block (so it stays findable, same rule as the delete path), or
      // already replaced by step 1's new event, which must not be disturbed.
      console.error(
        `[google/lessonEvents] event delete failed for lesson ${lessonId} (google_event_id ${inheritedEventId}); the block is still on the previous teacher's calendar: ${deleted.error}`
      )
      return
    }

    // The pointer is cleared ONLY when it still names the event just deleted. If
    // step 1 created a replacement it has already overwritten google_event_id,
    // and that id denotes a live block on the new owner's calendar - nulling it
    // would strand exactly the event this edit put there.
    if (newPointerWritten) return

    const { data: cleared, error: clearError } = await supabase
      .from('lessons')
      .update({ google_event_id: null })
      .eq('id', lessonId)
      .select('id')

    if (clearError) {
      // The block is gone but the lesson still names it. Harmless to the
      // calendar, and self-healing on any later delete (404 counts as success),
      // but it leaves a dead id on the row - so it is logged with both ids.
      console.error(
        'CRITICAL: Google Calendar event deleted but the lesson pointer could not be cleared:',
        { google_event_id: inheritedEventId, lesson_id: lessonId, error: clearError }
      )
      return
    }

    if (!cleared || cleared.length === 0) {
      // Same stale pointer, different cause: the UPDATE ran but matched no row
      // (the lesson was deleted from under us between the read above and here).
      console.error(
        'CRITICAL: Google Calendar event deleted but the pointer UPDATE matched 0 rows:',
        { google_event_id: inheritedEventId, lesson_id: lessonId }
      )
    }
  } catch (unexpected) {
    // The outer guarantee, exactly as on the other two paths. Anything
    // unforeseen dies quietly rather than reaching a caller whose lesson edit
    // is already committed and whose hours have already moved.
    console.error(
      `[google/lessonEvents] unexpected failure while updating the event for lesson ${lessonId}:`,
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
 *
 * Takes the lesson id alone: whose calendar the block sits on is read off the
 * row, never passed in, so no caller can get it wrong.
 */
export async function deleteLessonGoogleEvent(lessonId: string): Promise<void> {
  try {
    const supabase = createAdminClient()

    // ---- 1. Is there anything to delete, and whose is it --------------------
    // Explicit columns. google_event_id is the only handle that exists; id
    // rides along so a missing row is distinguishable from a null pointer;
    // teacher_id says which calendar that handle is meaningful against.
    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('id, teacher_id, google_event_id')
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

    // THE INVARIANT THAT MAKES READING teacher_id OFF THE ROW CORRECT: a stored
    // google_event_id always denotes an event on the CURRENT teacher's calendar.
    // A booking writes it under the teacher the class was booked with, and a
    // teacher swap does NOT carry the old id forward - updateLessonGoogleEvent's
    // previousTeacherId branch deletes the outgoing owner's event at swap time
    // and replaces the pointer with the new owner's. So the row as it stands now
    // can never send this delete at the wrong person's calendar.
    const teacherId = lesson.teacher_id
    if (typeof teacherId !== 'string' || teacherId.trim().length === 0) {
      // Anomalous: lessons.teacher_id is NOT NULL. Without it there is no
      // calendar to resolve, so the block stays where it is and this line names
      // both ids so it can still be found by hand.
      console.error(
        `[google/lessonEvents] lesson ${lessonId} carries no teacher_id; google_event_id ${eventId} was left on the calendar`
      )
      return
    }

    const accessToken = await resolveGoogleAccessToken(teacherId, lessonId)
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
