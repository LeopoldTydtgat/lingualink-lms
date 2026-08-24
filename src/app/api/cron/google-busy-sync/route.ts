import { NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { ORGANISER_UPN } from '@/lib/microsoft/graph'
import { refreshGoogleAccessToken } from '@/lib/google/oauth'
import { buildBusyIntervals, fetchGoogleCalendarEvents } from '@/lib/google/calendar'
import { isValidTimeZone } from '@/lib/utils/timezone'

// ---- What this route is (GCAL REBUILD 1, step 4) ----------------------------
//
// Mirrors the CONNECTED Google Calendar onto its owner's availability as
// read-only "busy" rows, so her outside commitments close bookable slots.
//
// The connection row is the single source of truth for WHOSE calendar this is.
// There is no separate "resolve the admin" step any more and there must never
// be one again: google_calendar_connections.profile_id names the profile, and
// that profile's timezone - read fresh every run - is the frame every local-day
// calculation in this sync uses.
//
// FAILURE DIRECTION, everywhere: over-blocked, never under-blocked. Any run
// that cannot build a complete picture returns WITHOUT touching availability,
// leaving the previous generation of blocks in place. Stale blocks cost a
// bookable slot; missing blocks hand out a double booking against a real
// commitment.
//
// HTTP: expected failures return 200 with an outcome body. A cron endpoint that
// 500s turns every transient Google hiccup into platform alert noise, and the
// health signal this feature actually uses is the settings failure counter, not
// the status code. Genuine cron-auth failure keeps verifyCronAuth's own status.

// Module-scope service-role client. Cron callers carry no Supabase session, so
// RLS is bypassed deliberately - and google_calendar_connections is deny-all to
// anon and authenticated (RLS with zero policies + REVOKE), so the service role
// is the only role that can read it at all.
const supabase = createAdminClient()

const WINDOW_DAYS = 60
// PostgREST puts .in() filters in the query string; a few hundred UUIDs would
// blow the URL length limit, so the delete is issued in batches.
const DELETE_CHUNK_SIZE = 100
// The last-error string is rendered verbatim in the admin's sync-health banner.
const MAX_ERROR_CHARS = 160

const FAILURE_KEY = 'google_busy_sync_failures'
const LAST_ERROR_KEY = 'google_busy_sync_last_error'
const LAST_SUCCESS_KEY = 'google_busy_sync_last_success_at'
// Set to 'true' the moment Google answers invalid_grant, cleared to 'false' by
// any successful run. Step 5 renders the reconnect banner from this key; this
// route only writes it. A dedicated key, not a magic value in LAST_ERROR_KEY,
// because "reconnect your calendar" is an action prompt and must not depend on
// pattern-matching an error string.
const REVOKED_KEY = 'google_busy_sync_revoked'

function errorMessage(raw: string): string {
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS - 1)}...` : raw
}

/**
 * Records that this cron FIRED (auth passed), not that it finished -
 * completed_at here is the fire time. cron_runs has UNIQUE (cron_name,
 * run_date); default upsert (ignoreDuplicates false) means sub-daily runs
 * refresh completed_at to the latest fire.
 *
 * cron_runs has exactly four columns (id, cron_name, run_date, completed_at) -
 * there is NO note column, so a run's outcome note lives in the server log, the
 * response body and the settings keys, never here.
 *
 * Best-effort: a heartbeat failure must never abort the job.
 */
async function heartbeat(): Promise<void> {
  const now = new Date()
  const runDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  const { error } = await supabase
    .from('cron_runs')
    .upsert(
      { cron_name: 'google-busy-sync', run_date: runDate, completed_at: now.toISOString() },
      { onConflict: 'cron_name,run_date' }
    )
  if (error) console.error('[heartbeat] cron_runs write failed:', error)
}

/**
 * Consecutive-failure counter read by the admin sync-health banner on the
 * teacher Schedule page. A failed read floors the counter at 1 rather than
 * guessing: under-counting only delays the banner, and the page's own settings
 * read fails open to showing it anyway.
 */
async function recordFailure(message: string): Promise<number> {
  const stamp = new Date().toISOString()
  let failures = 1

  const { data: row, error: readError } = await supabase
    .from('settings')
    .select('value')
    .eq('key', FAILURE_KEY)
    .maybeSingle()

  if (readError) {
    console.error('[google-busy-sync] failure-counter read failed:', readError)
  } else {
    const previous = Number.parseInt(row?.value ?? '', 10)
    if (Number.isFinite(previous) && previous > 0) failures = previous + 1
  }

  const { error: writeError } = await supabase.from('settings').upsert(
    [
      { key: FAILURE_KEY, value: String(failures), updated_at: stamp },
      { key: LAST_ERROR_KEY, value: `${message} (${stamp})`, updated_at: stamp },
    ],
    { onConflict: 'key' }
  )

  if (writeError) {
    console.error('[google-busy-sync] failure-counter write failed:', writeError)
  }

  return failures
}

async function recordSuccess(): Promise<void> {
  const stamp = new Date().toISOString()
  // REVOKED_KEY is written unconditionally rather than read-then-cleared: a
  // successful run PROVES the grant is live, so 'false' is always the right
  // value here, and one idempotent write beats a read/write pair that could
  // race with itself.
  //
  // LAST_ERROR_KEY is cleared here too: a last-error value that survives a
  // success describes a failure that is over, and misreports the cause if
  // anything ever reads it directly. Cleared to '' rather than deleted, so the
  // key's presence and the settings row shape stay unchanged.
  const { error } = await supabase.from('settings').upsert(
    [
      { key: FAILURE_KEY, value: '0', updated_at: stamp },
      { key: LAST_SUCCESS_KEY, value: stamp, updated_at: stamp },
      { key: REVOKED_KEY, value: 'false', updated_at: stamp },
      { key: LAST_ERROR_KEY, value: '', updated_at: stamp },
    ],
    { onConflict: 'key' }
  )
  if (error) {
    // The sync itself succeeded; a bookkeeping write failure must not be
    // reported as a sync failure, but it does need to be visible.
    console.error('[google-busy-sync] success-marker write failed:', error)
  }
}

/**
 * Expected-failure exit. Counts one consecutive failure, leaves every
 * availability row untouched, returns 200.
 */
async function fail(message: string): Promise<NextResponse> {
  const trimmed = errorMessage(message)
  console.error(`[google-busy-sync] ${trimmed}`)
  const failures = await recordFailure(trimmed)
  return NextResponse.json({
    ok: false,
    outcome: 'error',
    eventsFetched: 0,
    blocksWritten: 0,
    rowsDeleted: 0,
    failures,
    error: trimmed,
  })
}

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  await heartbeat()

  // ---- A. Which calendar, and whose --------------------------------------
  // Explicit columns. access_token / access_token_expires_at are deliberately
  // NOT read: this route refreshes unconditionally below, so the cached token
  // has no reader and pulling it into scope would only invite one.
  const { data: connectionRows, error: connectionError } = await supabase
    .from('google_calendar_connections')
    .select('id, profile_id, google_email, refresh_token')

  if (connectionError) {
    return fail(`Google connection lookup failed: ${connectionError.message}`)
  }

  const connections = connectionRows ?? []

  if (connections.length === 0) {
    // NOT A FAILURE. A platform where nobody has connected a calendar yet is
    // healthy: there is nothing to mirror. Counting this would march the
    // failure counter to its threshold and put a red "sync is failing" banner
    // in front of an admin who has simply not clicked Connect. Nothing is
    // reset either - a previous run's counters are not this run's business.
    console.log('[google-busy-sync] skipped - no Google Calendar is connected')
    return NextResponse.json({
      ok: true,
      outcome: 'skipped',
      reason: 'not connected',
      eventsFetched: 0,
      blocksWritten: 0,
      rowsDeleted: 0,
    })
  }

  if (connections.length > 1) {
    // Single-connection feature by design (one row, one settings failure key,
    // one revoked key). More than one row means the model moved and this route
    // would have to guess which calendar owns the google_sync rows. Refuse
    // rather than guess: no writes, previous blocks survive.
    return fail(
      `Expected at most 1 Google Calendar connection, found ${connections.length}`
    )
  }

  const connection = connections[0]

  const refreshToken = connection.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    return fail(`Connection ${connection.id} carries no refresh token`)
  }

  // The connection row says whose calendar this is. Read that profile's
  // timezone FRESH every run: she can change it in the portal, and a stale copy
  // would silently split every multi-day block on the wrong midnight.
  const { data: profileRow, error: profileError } = await supabase
    .from('profiles')
    .select('id, timezone')
    .eq('id', connection.profile_id)
    .maybeSingle()

  if (profileError) {
    return fail(`Profile lookup failed for ${connection.profile_id}: ${profileError.message}`)
  }
  if (!profileRow) {
    return fail(`Connected profile ${connection.profile_id} no longer exists`)
  }

  const timezone: unknown = profileRow.timezone
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) {
    // Fail closed. Guessing UTC here would place every block hours off in her
    // own frame and split multi-day events on the wrong boundary.
    return fail(
      `Connected profile ${profileRow.id} has no usable timezone (got ${JSON.stringify(timezone)})`
    )
  }

  // ---- A2. The ids of our own class blocks on this calendar ---------------
  // Every google_event_id we have written onto one of this teacher's lessons.
  // buildBusyIntervals skips these, so a class block the outbound sync put on
  // her calendar can never come back through this sync as a busy row over the
  // slot the platform itself booked.
  //
  // Read BEFORE the token refresh deliberately: a database failure here must
  // exit before spending a Google round trip on a run that is going to abort
  // anyway.
  //
  // Subject to PostgREST's max-rows cap (1000). Truncation is tolerable in this
  // one direction only, and it is the direction that happens: a missing id
  // leaves one of our own events unskipped, which over-blocks a slot that is
  // ALREADY booked by the class that event represents. That costs nothing real.
  // The opposite failure - a class event mirrored back over a freed slot - is
  // what this filter exists to prevent, and truncation cannot cause it.
  const { data: classEventRows, error: classEventError } = await supabase
    .from('lessons')
    .select('google_event_id')
    .eq('teacher_id', profileRow.id)
    .not('google_event_id', 'is', null)

  if (classEventError) {
    // Same incomplete-picture rule as every other read in this route: without
    // the full id list the echo filter is partial, so nothing is written and
    // the previous generation of blocks survives untouched.
    return fail(`Class event id lookup failed: ${classEventError.message}`)
  }

  const classEventIds = new Set<string>()
  for (const row of classEventRows ?? []) {
    const eventId: unknown = row.google_event_id
    // Non-empty strings only. A whitespace-only pointer matches no Google id
    // and would only sit in the set forever.
    if (typeof eventId === 'string' && eventId.trim().length > 0) classEventIds.add(eventId)
  }

  // ---- B. Token refresh, every run, unconditionally ----------------------
  // No "is the stored access token still valid?" branch. The token lives ~60
  // minutes and this cron runs far more often, so a conditional-reuse path
  // would be a second code path that only executes when the token is stale -
  // the least-exercised branch, running at the worst moment.
  const refresh = await refreshGoogleAccessToken(refreshToken)

  if (refresh.outcome === 'revoked') {
    const message = 'Google Calendar access was revoked - the account must be reconnected'
    console.error(`[google-busy-sync] ${message}`)

    const stamp = new Date().toISOString()
    const { error: revokedWriteError } = await supabase
      .from('settings')
      .upsert([{ key: REVOKED_KEY, value: 'true', updated_at: stamp }], { onConflict: 'key' })
    if (revokedWriteError) {
      console.error('[google-busy-sync] revoked-marker write failed:', revokedWriteError)
    }

    const failures = await recordFailure(message)
    // No availability writes: her existing Google blocks stay exactly as they
    // are until a human reconnects. Over-blocked, never under-blocked.
    return NextResponse.json({
      ok: false,
      outcome: 'revoked',
      eventsFetched: 0,
      blocksWritten: 0,
      rowsDeleted: 0,
      failures,
      error: message,
    })
  }

  if (refresh.outcome !== 'refreshed' || !refresh.accessToken) {
    return fail(`Token refresh failed: ${refresh.error ?? 'unknown error'}`)
  }

  const accessToken = refresh.accessToken

  // Cache the fresh token on the connection row. BEST EFFORT: nothing in this
  // run reads it back, so a failed write is logged and the sync continues.
  {
    const { error: tokenWriteError } = await supabase
      .from('google_calendar_connections')
      .update({
        access_token: accessToken,
        access_token_expires_at: refresh.expiresAtIso,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connection.id)
    if (tokenWriteError) {
      console.error('[google-busy-sync] access-token cache update failed:', tokenWriteError)
    }
  }

  // ---- C. Fetch the window ------------------------------------------------
  const windowStartMs = Date.now()
  const windowEndMs = windowStartMs + WINDOW_DAYS * 24 * 60 * 60 * 1000

  // toISOString on a real instant for an API query parameter is not the banned
  // pattern: the ban is on building a LOCAL calendar date from it. These are
  // UTC instants being sent as UTC instants.
  const fetched = await fetchGoogleCalendarEvents({
    accessToken,
    timeMinIso: new Date(windowStartMs).toISOString(),
    timeMaxIso: new Date(windowEndMs).toISOString(),
  })

  if (!fetched.ok) {
    // Includes the page-cap bail. A partial event list followed by the
    // generational delete below would wipe blocks covering real commitments.
    return fail(fetched.error)
  }

  // ---- D + E. Filter, convert, split, merge -------------------------------
  const { intervals, skipped } = buildBusyIntervals(fetched.events, {
    timezone,
    // Same constant the Teams integration creates every class meeting under.
    // Never a second hardcoded copy: if the organiser account moves, it moves
    // in one place and this filter follows it.
    organiserEmail: ORGANISER_UPN,
    // The second half of the echo filter: our own outbound class blocks, by the
    // ids we stored when we wrote them.
    classEventIds,
    windowStartMs,
    windowEndMs,
  })

  // ---- F. Generational write: insert BEFORE delete ------------------------
  // Deliberate ordering, unchanged from the previous implementation. A crash
  // between the two steps leaves both generations of rows in place - duplicate
  // blocks over-block, which costs a bookable slot and nothing else, and the
  // next run clears them. Delete-first would open a window where her Google
  // commitments block nothing at all.
  //
  // Known and accepted: two overlapping runs could leave both generations
  // behind. That is the safe direction and the next clean run replaces
  // everything. No locking mechanism.

  // F1. Snapshot the rows this run replaces. Scoped to source='google_sync' and
  // to this teacher: manual availability is never selected, so it can never be
  // deleted below. No time filter - a window-bounded select never caught rows
  // that had already fully elapsed, so every run orphaned yesterday's blocks
  // permanently. Selecting every sync-owned row makes each run a full
  // replacement of the previous generation.
  const { data: existingRows, error: existingError } = await supabase
    .from('availability')
    .select('id')
    .eq('teacher_id', profileRow.id)
    .eq('source', 'google_sync')

  if (existingError) {
    return fail(`Existing block lookup failed: ${existingError.message}`)
  }

  const staleIds: string[] = (existingRows ?? []).map((row) => row.id)

  // F2. Insert the new generation. day_of_week/start_time/end_time stay NULL:
  // the slot engine and booking gate read a 'specific' row with is_available
  // false and both instants populated as a timed block
  // (src/lib/availability.ts, blockOverrides). source='google_sync' is one of
  // the two values allowed by availability_source_check.
  if (intervals.length > 0) {
    const { error: insertError } = await supabase.from('availability').insert(
      intervals.map((interval) => ({
        teacher_id: profileRow.id,
        type: 'specific',
        is_available: false,
        source: 'google_sync',
        start_at: new Date(interval.startMs).toISOString(),
        end_at: new Date(interval.endMs).toISOString(),
        day_of_week: null,
        start_time: null,
        end_time: null,
      }))
    )

    if (insertError) {
      // No delete on a failed insert - the old rows are all the blocking cover
      // that is left.
      return fail(`Block insert failed: ${insertError.message}`)
    }
  }

  // F3. Delete the previous generation by the ids captured in F1.
  let rowsDeleted = 0
  let warning: string | undefined

  for (let i = 0; i < staleIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = staleIds.slice(i, i + DELETE_CHUNK_SIZE)
    // Defence in depth only: the F1 snapshot already scoped these ids to
    // source='google_sync', so this filter can never change what gets deleted.
    const { error: deleteError } = await supabase
      .from('availability')
      .delete()
      .eq('source', 'google_sync')
      .in('id', chunk)

    if (deleteError) {
      console.error('[google-busy-sync] stale block delete failed:', deleteError)
      warning = `Inserted ${intervals.length} block(s) but failed to delete ${
        staleIds.length - rowsDeleted
      } superseded row(s): ${errorMessage(deleteError.message)}. They over-block until the next run clears them.`
      break
    }
    rowsDeleted += chunk.length
  }

  // ---- G. Bookkeeping -----------------------------------------------------
  // A failed delete leaves duplicates, which is the safe direction - the run
  // still counts as a success and the counter resets.
  await recordSuccess()

  console.log(
    `[google-busy-sync] ok - ${fetched.events.length} event(s) over ${fetched.pages} page(s), ` +
      `${intervals.length} block(s) written, ${rowsDeleted} superseded row(s) deleted; ` +
      `skipped ${skipped.notConfirmed} unconfirmed, ${skipped.allDay} all-day, ` +
      `${skipped.transparent} free, ${skipped.ownTeamsInvite} own-invite, ` +
      `${skipped.ownClassEvent} own-class-block, ` +
      `${skipped.unusableTimes} unusable, ${skipped.outsideWindow} out-of-window`
  )

  return NextResponse.json({
    ok: true,
    outcome: 'synced',
    eventsFetched: fetched.events.length,
    blocksWritten: intervals.length,
    rowsDeleted,
    skipped,
    failures: 0,
    ...(warning ? { warning } : {}),
  })
}
