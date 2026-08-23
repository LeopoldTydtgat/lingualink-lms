// Google Calendar API helpers - the read side that feeds the busy-sync cron
// (GCAL REBUILD 1), and the outbound event writes at the bottom of the file.
//
// Lives here rather than in the route so the interval maths - the part that
// decides what does and does not block a real teacher's calendar - is pure and
// unit-testable (src/lib/google/calendar.test.ts). The route keeps only the
// run sequence and the database writes.
//
// Server-only. Callers hold a live bearer token; nothing here may reach the
// browser bundle.
//
// NO SDK. Native fetch against the REST endpoint, deliberately: googleapis is a
// very large dependency for three query parameters, a page loop and three
// single-event writes.

import { addDaysToDateKey, getLocalDateKey, wallTimeToUtcMs } from '@/lib/utils/timezone'

export const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

/** Google's documented maximum for this endpoint. */
const PAGE_SIZE = 250

/**
 * Hard stop on the page loop. 20 pages x 250 = 5000 expanded instances in a
 * 60-day window; a real calendar does not come close. Hitting it means
 * something is wrong, and the ONLY safe response is to fail the run: a partial
 * event list followed by the generational delete would wipe blocks that cover
 * real commitments.
 */
export const MAX_EVENT_PAGES = 20

const FETCH_TIMEOUT_MS = 10_000

/**
 * Safety valve on the midnight-split loop. The caller clamps every interval to
 * a 60-day window, so the real ceiling is ~62 segments; this can only trip if
 * the timezone helpers stop advancing, and it exists purely so a bad tz can
 * never hang an unattended cron.
 */
const MAX_SEGMENTS_PER_EVENT = 400

// ---- Wire shapes ------------------------------------------------------------
// Only the fields this sync reads. Everything optional and nullable: these are
// remote JSON, not a schema we control.

export interface GoogleEventTime {
  dateTime?: string | null
  date?: string | null
  timeZone?: string | null
}

export interface GoogleCalendarEvent {
  id?: string | null
  summary?: string | null
  status?: string | null
  transparency?: string | null
  organizer?: { email?: string | null; self?: boolean | null } | null
  start?: GoogleEventTime | null
  end?: GoogleEventTime | null
}

export type GoogleEventsResult =
  | { ok: true; events: GoogleCalendarEvent[]; pages: number }
  | { ok: false; error: string }

function readErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}

/**
 * Items of one page, or null when the page is not shaped like a page.
 *
 * A missing/null `items` is a legal empty page. A non-array `items`, or an
 * array holding anything that is not an object, is a malformed response and
 * fails the run rather than being quietly filtered: silently dropping entries
 * here would under-block, which is the one direction this sync must never fail
 * in.
 */
function readItems(body: unknown): GoogleCalendarEvent[] | null {
  if (!body || typeof body !== 'object') return null
  const items = (body as { items?: unknown }).items
  if (items === undefined || items === null) return []
  if (!Array.isArray(items)) return null
  if (!items.every((item) => Boolean(item) && typeof item === 'object')) return null
  return items as GoogleCalendarEvent[]
}

function readNextPageToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const token = (body as { nextPageToken?: unknown }).nextPageToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

/**
 * Every event instance between timeMin and timeMax, following nextPageToken to
 * exhaustion.
 *
 * singleEvents=true is REQUIRED, not a preference: it makes Google expand
 * recurring events into concrete instances server-side, including the
 * per-instance cancellations and overrides. We must never parse RRULEs
 * ourselves - that was the previous implementation's whole failure surface.
 *
 * showDeleted is deliberately NOT set. Its default (false) already excludes
 * cancelled events; setting it true and re-filtering would be a second way to
 * get the same answer, and the wrong default there ships ghost blocks.
 *
 * timeMin filters on the event's END time, so an event already in progress when
 * the cron fires IS returned. That is correct and load-bearing: the remainder
 * of a meeting she is sitting in must still block.
 *
 * Never throws - the caller is an unattended cron.
 */
export async function fetchGoogleCalendarEvents(options: {
  accessToken: string
  timeMinIso: string
  timeMaxIso: string
}): Promise<GoogleEventsResult> {
  const events: GoogleCalendarEvent[] = []
  let pageToken: string | null = null

  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = new URLSearchParams({
      timeMin: options.timeMinIso,
      timeMax: options.timeMaxIso,
      singleEvents: 'true',
      maxResults: String(PAGE_SIZE),
    })
    if (pageToken) query.set('pageToken', pageToken)

    let response: Response
    try {
      response = await fetch(`${GOOGLE_CALENDAR_EVENTS_ENDPOINT}?${query.toString()}`, {
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      })
    } catch (networkError) {
      console.error('[google/calendar] events request failed:', networkError)
      return { ok: false, error: 'Google Calendar events request failed (network or timeout)' }
    }

    const body: unknown = await response.json().catch((parseError: unknown) => {
      console.error('[google/calendar] events response was not JSON:', response.status, parseError)
      return null
    })

    if (!response.ok) {
      const message = readErrorMessage(body)
      console.error('[google/calendar] events request rejected:', response.status, message)
      return {
        ok: false,
        error: `Google Calendar returned HTTP ${response.status}${message ? `: ${message}` : ''}`,
      }
    }

    const items = readItems(body)
    if (items === null) {
      console.error('[google/calendar] events response was not shaped like an events page')
      return { ok: false, error: 'Google Calendar returned an unreadable events page' }
    }

    events.push(...items)

    const next = readNextPageToken(body)
    if (!next) return { ok: true, events, pages: page + 1 }
    pageToken = next
  }

  // Fell out of the loop with a page token still outstanding: the event list is
  // incomplete. Bail WITHOUT writing.
  return {
    ok: false,
    error: `Google Calendar paging exceeded ${MAX_EVENT_PAGES} pages; refusing to write a partial calendar`,
  }
}

// ---- Busy intervals ---------------------------------------------------------

export interface BusyInterval {
  startMs: number
  endMs: number
}

export interface BusySkipCounts {
  notConfirmed: number
  allDay: number
  transparent: number
  ownTeamsInvite: number
  ownClassEvent: number
  unusableTimes: number
  outsideWindow: number
}

export interface BusyBuildResult {
  intervals: BusyInterval[]
  skipped: BusySkipCounts
}

/** The UTC instant of the next local midnight strictly after `fromMs` in `tz`. */
function nextLocalMidnightMs(fromMs: number, tz: string): number {
  const dayKey = getLocalDateKey(new Date(fromMs), tz)
  const nextKey = addDaysToDateKey(dayKey, 1)
  const [year, month, day] = nextKey.split('-').map(Number)
  // wallTimeToUtcMs is the project's one DST-correct local->UTC primitive
  // (shared with the booking gate and slot engine). On a zone that starts DST
  // at midnight, 00:00 does not exist and it returns the forward-shifted
  // instant - still a strictly increasing boundary, which is all this needs.
  return wallTimeToUtcMs(year, month, day, 0, 0, tz)
}

/**
 * One interval per local calendar day it touches, split at local midnight.
 *
 * HARD REQUIREMENT, not an optimisation. The Day-to-Day renderer
 * (src/app/(dashboard)/schedule/tabs/DayToDay.tsx, expandSpecificBlocks) clamps
 * a row whose start and end fall on different local days to `endMin = 24*60` on
 * its FIRST day. An unsplit three-day conference would therefore paint day one
 * and nothing else, while the booking gate - which matches on raw instants -
 * blocked all three days. That silent disagreement between what she sees and
 * what students can book is exactly the failure this rebuild exists to kill,
 * and the fix belongs on the writer side: the renderer is shared with manual
 * rows and must not be touched.
 *
 * The final segment MAY end exactly at the next local midnight (a 22:00-00:00
 * event yields one segment). That is fine: the renderer's clamp then lands on
 * the row's true end.
 */
export function splitAtLocalMidnights(interval: BusyInterval, tz: string): BusyInterval[] {
  const segments: BusyInterval[] = []
  let cursor = interval.startMs
  let exhausted = true

  for (let i = 0; i < MAX_SEGMENTS_PER_EVENT; i++) {
    const boundary = nextLocalMidnightMs(cursor, tz)
    // A non-advancing boundary would spin forever. Bail and emit the remainder
    // as one segment: over-blocked and mis-drawn beats an unattended hang.
    if (!Number.isFinite(boundary) || boundary <= cursor) {
      console.error(
        `[google/calendar] midnight boundary failed to advance past ${cursor}; emitting the remainder unsplit`
      )
      exhausted = false
      break
    }
    if (boundary >= interval.endMs) {
      exhausted = false
      break
    }
    segments.push({ startMs: cursor, endMs: boundary })
    cursor = boundary
  }

  if (exhausted) {
    console.error(
      `[google/calendar] midnight split hit the ${MAX_SEGMENTS_PER_EVENT}-segment cap; emitting the remainder unsplit`
    )
  }

  segments.push({ startMs: cursor, endMs: interval.endMs })
  return segments
}

/**
 * Merges overlapping and touching intervals, but only WITHIN a local day.
 *
 * The per-day bucketing is load-bearing. A plain global merge would re-join the
 * two halves of a split cross-midnight event across the boundary and undo the
 * split above, because they touch exactly. Two overlapping meetings on the same
 * day must not produce two overlapping rows; two segments either side of
 * midnight must stay two rows.
 */
export function mergeIntervalsWithinLocalDays(
  intervals: BusyInterval[],
  tz: string
): BusyInterval[] {
  const buckets = new Map<string, BusyInterval[]>()
  for (const interval of intervals) {
    // Keyed on the START instant: every interval reaching here begins on, and
    // ends no later than the midnight ending, a single local day.
    const dayKey = getLocalDateKey(new Date(interval.startMs), tz)
    const bucket = buckets.get(dayKey)
    if (bucket) bucket.push(interval)
    else buckets.set(dayKey, [interval])
  }

  const merged: BusyInterval[] = []
  for (const dayKey of [...buckets.keys()].sort()) {
    const dayIntervals = [...(buckets.get(dayKey) ?? [])].sort((a, b) => a.startMs - b.startMs)
    const dayMerged: BusyInterval[] = []
    for (const interval of dayIntervals) {
      const last = dayMerged[dayMerged.length - 1]
      // `<=` collapses touching ranges too: identical blocking effect, fewer
      // rows to write, delete and re-read every run.
      if (last && interval.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, interval.endMs)
      } else {
        dayMerged.push({ ...interval })
      }
    }
    merged.push(...dayMerged)
  }

  return merged
}

/**
 * Google event instances -> the busy intervals this teacher's availability rows
 * must cover, in her own timezone.
 *
 * Pure. Every skip is counted rather than discarded, so a run that writes
 * nothing can still say why.
 */
export function buildBusyIntervals(
  events: GoogleCalendarEvent[],
  options: {
    /** The CONNECTED profile's timezone - never a separately resolved "admin". */
    timezone: string
    /** The platform's M365 organiser account, for the echo filter. */
    organiserEmail: string
    /**
     * Every google_event_id currently stored on this teacher's lessons - the
     * ids of the blocks our own outbound sync wrote to her calendar.
     *
     * REQUIRED, and deliberately not optional with an empty-set default: a
     * caller that forgets it must be a type error, never a silently disabled
     * echo filter. An empty set is a caller SAYING there is nothing to skip.
     */
    classEventIds: Set<string>
    windowStartMs: number
    windowEndMs: number
  }
): BusyBuildResult {
  const { timezone, organiserEmail, classEventIds, windowStartMs, windowEndMs } = options
  const organiser = organiserEmail.trim().toLowerCase()

  const skipped: BusySkipCounts = {
    notConfirmed: 0,
    allDay: 0,
    transparent: 0,
    ownTeamsInvite: 0,
    ownClassEvent: 0,
    unusableTimes: 0,
    outsideWindow: 0,
  }

  const clamped: BusyInterval[] = []

  for (const event of events) {
    // 1. Only confirmed events block. Compared trimmed and lower-cased so a
    //    stray case or whitespace variant of "confirmed" from Google still
    //    matches instead of silently falling through to the unsafe
    //    (under-blocking) direction.
    //    'cancelled' should not reach us at all (showDeleted defaults to false)
    //    - this is defence in depth, not the primary exclusion. 'tentative' is
    //    skipped as a DELIBERATE PRODUCT CALL: this sync mirrors confirmed busy
    //    time only, so a maybe on her Google does not silently close a bookable
    //    slot. An ABSENT (non-string) status is read as confirmed, because
    //    over-blocking is the safe direction for an unreadable field.
    const status = typeof event.status === 'string' ? event.status.trim().toLowerCase() : 'confirmed'
    if (status !== 'confirmed') {
      skipped.notConfirmed++
      continue
    }

    // 2. All-day events (start.date instead of start.dateTime) are SKIPPED
    //    ENTIRELY. They are birthdays, holidays-of-note and reminders far more
    //    often than real busy time, and blocking a whole day on one would cost
    //    her every bookable slot on it. The old ICS sync never blocked them
    //    either; this preserves that behaviour exactly.
    if (event.start?.date && !event.start?.dateTime) {
      skipped.allDay++
      continue
    }

    // 3. transparency 'transparent' is Google's "Free" marker: the event exists
    //    but must not block.
    if ((event.transparency ?? '').trim().toLowerCase() === 'transparent') {
      skipped.transparent++
      continue
    }

    // 4. ECHO FILTER - the inbound half of the original ghost bug.
    //    Our own Teams class invites are created under the platform's M365
    //    organiser account and land in her Google inbox; once accepted they come
    //    back through this sync as "busy". Mirroring them would block the very
    //    slots the platform just booked, and then block them again after the
    //    class is cancelled and the Google copy lingers. The identity is read
    //    from the same constant the Teams integration creates meetings under -
    //    there is exactly one copy of it in the codebase.
    const organizerEmail = event.organizer?.email
    if (
      typeof organizerEmail === 'string' &&
      organizerEmail.trim().toLowerCase() === organiser
    ) {
      skipped.ownTeamsInvite++
      continue
    }

    // 5. ECHO FILTER, second half - by stored event id.
    //    These are the platform's OWN class time-blocks, written onto this same
    //    calendar by the outbound sync at the bottom of this file, and their
    //    ids are the ones we stored on lessons.google_event_id. They carry no
    //    organiser identity that check 4 could catch: she created them herself,
    //    through us. Mirroring one back would block the very slot the platform
    //    itself booked - and worse, a cancellation frees the slot in LinguaLink
    //    the moment it happens, so an echo block that outlived it would keep
    //    that freed slot closed for one more cycle, against a class that no
    //    longer exists.
    //    A missing, null or non-string id falls through untouched: an event we
    //    cannot identify is somebody else's commitment until proven otherwise,
    //    and over-blocking is this sync's safe direction.
    const eventId = event.id
    if (typeof eventId === 'string' && classEventIds.has(eventId)) {
      skipped.ownClassEvent++
      continue
    }

    // start/end carry an RFC3339 string WITH an offset, so the instant is
    // unambiguous and event.start.timeZone is not consulted. Date.parse of a
    // missing value is NaN, which lands in unusableTimes rather than silently
    // becoming epoch zero.
    const startMs = Date.parse(event.start?.dateTime ?? '')
    const endMs = Date.parse(event.end?.dateTime ?? '')
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      skipped.unusableTimes++
      continue
    }

    // Clamp to the sync window. An in-progress event (returned because timeMin
    // filters on END time) has its start pulled forward to now, so it blocks the
    // remainder of itself and nothing in the past.
    const clampedStart = Math.max(startMs, windowStartMs)
    const clampedEnd = Math.min(endMs, windowEndMs)
    if (clampedEnd <= clampedStart) {
      skipped.outsideWindow++
      continue
    }

    clamped.push({ startMs: clampedStart, endMs: clampedEnd })
  }

  const split = clamped.flatMap((interval) => splitAtLocalMidnights(interval, timezone))
  return { intervals: mergeIntervalsWithinLocalDays(split, timezone), skipped }
}

// ---- Outbound writes --------------------------------------------------------
//
// The mirror image of the sync above: instead of reading Google's busy time
// into LinguaLink, these put a LinguaLink class onto the connected person's own
// primary calendar as a plain time-block.
//
// NO ATTENDEES, EVER. This is the hardest rule in the file. The event is a
// private block on ONE person's own calendar, not an invitation: the moment an
// `attendees` array (or `sendUpdates`, or `guestsCanModify`) appears in any
// request below, Google emails a student or a teacher FROM HER PERSONAL GOOGLE
// ACCOUNT, from an address they have never seen, about a class the platform has
// already told them about. Meeting invitations belong to the Teams integration
// (src/lib/microsoft/graph.ts) and go out under the platform organiser account.
// Nothing in this section may notify anybody.
//
// `reminders` is left off every request body for the same kind of reason:
// omitted means the calendar's own default reminders apply, which is what she
// has already chosen for herself. Sending overrides would silently retune her
// own notifications from inside a booking flow.
//
// NO RETRIES. Unlike the cron above, these run inside user-facing request
// paths, so a retry loop would spend somebody's page load on it. One request,
// then a result the caller decides about.

export type GoogleEventCreateResult =
  | { ok: true; eventId: string }
  | { ok: false; error: string }

/** Update and delete have nothing to hand back but the outcome. */
export type GoogleEventWriteResult = { ok: true } | { ok: false; error: string }

/**
 * `ok` here means the request completed - NOT that Google accepted it. The
 * status is still the caller's to read.
 */
type GoogleEventRequestAttempt =
  | { ok: true; response: Response }
  | { ok: false; error: string }

/**
 * The single-event URL, built from the one endpoint constant so that
 * 'calendars/primary' exists exactly once in this codebase.
 *
 * The id is percent-encoded: it is opaque, caller-stored data and must never be
 * able to reshape the path it is pasted into.
 */
function singleEventUrl(eventId: string): string {
  return `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(eventId)}`
}

/** One request, one 10s timeout, no retry. Never throws. */
async function sendEventRequest(
  action: string,
  url: string,
  init: RequestInit
): Promise<GoogleEventRequestAttempt> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    return { ok: true, response }
  } catch (networkError) {
    console.error(`[google/calendar] ${action} request failed:`, networkError)
    return { ok: false, error: `Google Calendar ${action} failed (network or timeout)` }
  }
}

/**
 * Google's own message off a rejected response, or null.
 *
 * Only that one field is kept - a full event payload carries the summary of
 * somebody's private appointment and has no business in a log line. A body that
 * is not JSON at all is unremarkable on a failing response, so the parse error
 * is swallowed here; the status is logged by the caller either way.
 */
async function readRejectionMessage(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null)
  return readErrorMessage(body)
}

/** The shared non-2xx branch, so the three helpers cannot report differently. */
function eventRequestRejected(
  action: string,
  status: number,
  message: string | null
): { ok: false; error: string } {
  console.error(`[google/calendar] ${action} rejected:`, status, message)
  return {
    ok: false,
    error: `Google Calendar returned HTTP ${status}${message ? `: ${message}` : ''}`,
  }
}

/**
 * Creates the time-block and returns its id, which the caller MUST store: it is
 * the only handle on the event afterwards.
 *
 * Never throws. A rejection from Google is an expected outcome here, not an
 * exception.
 */
export async function createGoogleEvent(options: {
  accessToken: string
  summary: string
  startIso: string
  endIso: string
  timezone: string
}): Promise<GoogleEventCreateResult> {
  const attempt = await sendEventRequest('event create', GOOGLE_CALENDAR_EVENTS_ENDPOINT, {
    method: 'POST',
    headers: {
      // Header only. A bearer token in a query string ends up in proxy logs,
      // browser history and Referer headers.
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    // Three fields, and nothing else by design - see the section header.
    // Google treats the offset inside an RFC3339 dateTime as authoritative and
    // falls back to timeZone only when the string carries none, so sending both
    // is safe in either direction: they cannot disagree about the instant.
    body: JSON.stringify({
      summary: options.summary,
      start: { dateTime: options.startIso, timeZone: options.timezone },
      end: { dateTime: options.endIso, timeZone: options.timezone },
    }),
  })
  if (!attempt.ok) return attempt

  const body: unknown = await attempt.response.json().catch(() => null)

  if (!attempt.response.ok) {
    return eventRequestRejected('event create', attempt.response.status, readErrorMessage(body))
  }

  const eventId = (body as { id?: unknown } | null)?.id
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    // The event almost certainly EXISTS on her calendar at this point - we just
    // cannot hand the caller a handle for it. That is a failure, not a success:
    // a caller told "ok" would record nothing and could never update or delete
    // the block again.
    console.error('[google/calendar] event create returned no usable id')
    return { ok: false, error: 'Google Calendar created the event but returned no id' }
  }

  return { ok: true, eventId }
}

/**
 * Moves an existing block. PATCH, not PUT, and start/end only: every field left
 * out of the body stays as it is on Google's side.
 *
 * The summary is deliberately NOT resent. If she has renamed the block on her
 * own calendar, that rename is hers and a reschedule must not quietly undo it.
 *
 * Unlike the delete below, a 404 here is a REAL failure: the block did not
 * move, and a caller told otherwise would record a time the calendar does not
 * show.
 */
export async function updateGoogleEvent(options: {
  accessToken: string
  eventId: string
  startIso: string
  endIso: string
  timezone: string
}): Promise<GoogleEventWriteResult> {
  const attempt = await sendEventRequest('event update', singleEventUrl(options.eventId), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      start: { dateTime: options.startIso, timeZone: options.timezone },
      end: { dateTime: options.endIso, timeZone: options.timezone },
    }),
  })
  if (!attempt.ok) return attempt

  if (attempt.response.ok) return { ok: true }

  return eventRequestRejected(
    'event update',
    attempt.response.status,
    await readRejectionMessage(attempt.response)
  )
}

/**
 * Deletes the block.
 *
 * 404 AND 410 ARE SUCCESS, deliberately. Both mean the event is already gone -
 * 404 for an id Google no longer recognises, 410 for one it knows was deleted -
 * and "gone" is precisely the end state the caller asked for. Reporting failure
 * would strand a cleanup path on an event that can never be deleted a second
 * time, leaving a cancelled class holding a dead event id it is never allowed
 * to clear. Same reasoning as cancelTeamsMeeting's 404 branch in
 * src/lib/microsoft/graph.ts.
 *
 * Every other rejection (401, 403, 5xx) is still reported: those say nothing
 * about whether the event survived, and the caller can act on them.
 */
export async function deleteGoogleEvent(options: {
  accessToken: string
  eventId: string
}): Promise<GoogleEventWriteResult> {
  const attempt = await sendEventRequest('event delete', singleEventUrl(options.eventId), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!attempt.ok) return attempt

  // Google answers 204 No Content, so nothing is parsed on the success path.
  if (attempt.response.ok) return { ok: true }

  if (attempt.response.status === 404 || attempt.response.status === 410) return { ok: true }

  return eventRequestRejected(
    'event delete',
    attempt.response.status,
    await readRejectionMessage(attempt.response)
  )
}
