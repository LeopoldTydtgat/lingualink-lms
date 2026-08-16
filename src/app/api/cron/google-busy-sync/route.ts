import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import ical from 'node-ical'
import type { EventInstance, VEvent } from 'node-ical'
import { verifyCronAuth } from '@/lib/cron-auth'
import {
  addDaysToDateKey,
  isValidTimeZone,
  wallTimeToUtcMs,
} from '@/lib/utils/timezone'

// Module-scope service-role client, same shape as the other cron routes
// (src/app/api/cron/invoice-reminder/route.ts). Cron callers carry no Supabase
// session, so RLS is bypassed deliberately here.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Feature scope ────────────────────────────────────────────────────────────
// SINGLE-USER BY CLIENT INSTRUCTION. This mirrors ONE Google calendar onto ONE
// account — the admin teacher — and is deliberately not generalised: no
// per-profile config table, no per-teacher ICS URL, no multi-target loop. The
// target is resolved as "the single profiles row with role = 'admin'"; if that
// ever stops being exactly one row the run aborts rather than guessing.

const WINDOW_DAYS = 60
const FETCH_TIMEOUT_MS = 10_000
// PostgREST puts .in() filters in the query string; a few hundred UUIDs would
// blow the URL length limit, so the delete is issued in batches.
const DELETE_CHUNK_SIZE = 100
// The last-error string is rendered verbatim in the admin's sync-health banner.
const MAX_ERROR_CHARS = 160

const FAILURE_KEY = 'google_busy_sync_failures'
const LAST_ERROR_KEY = 'google_busy_sync_last_error'
const LAST_SUCCESS_KEY = 'google_busy_sync_last_success_at'

interface BusyBlock {
  startMs: number
  endMs: number
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS - 1)}…` : raw
}

function isVEvent(component: unknown): component is VEvent {
  return (
    typeof component === 'object' &&
    component !== null &&
    (component as { type?: unknown }).type === 'VEVENT'
  )
}

// node-ical returns either a bare string or a { params, val } wrapper for any
// property that carried iCalendar parameters (its ParameterValue type). Both
// shapes reach TRANSP/STATUS, so unwrap before comparing.
function readTextValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object' && 'val' in raw) {
    const val = (raw as { val: unknown }).val
    if (typeof val === 'string') return val
  }
  return null
}

// TRANSP:TRANSPARENT is Google's "free" marker — the event exists but must not
// block. STATUS:CANCELLED is a deleted event still present in the feed. Only a
// POSITIVE match skips: anything unreadable stays a busy block, because
// over-blocking is safe here and under-blocking hands out a real double booking.
function isNonBlocking(event: VEvent): boolean {
  if (readTextValue(event.transparency)?.toUpperCase() === 'TRANSPARENT') return true
  return readTextValue(event.status)?.toUpperCase() === 'CANCELLED'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

// node-ical parses a VALUE=DATE (all-day) value as *host-local* midnight and
// flags it dateOnly (node_modules/node-ical/lib/ical-parser-utils.js:666), and
// expandRecurringEvent rebuilds every full-day instance the same way
// (lib/expand-recurring-event.js:74-86). So the intended calendar date lives in
// the LOCAL getters, never the UTC ones — reading getUTCDate() here is what
// would shift an all-day event a day on a host west of UTC.
function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// A YYYY-MM-DD calendar date → the UTC instant of that day's 00:00 in `tz`.
// wallTimeToUtcMs is the project's one DST-correct local→UTC primitive (shared
// with the booking gate and slot engine); a bare DATE must never be read as UTC
// midnight or the block lands hours off in the teacher's own frame.
function zoneMidnightUtcMs(dateKey: string, tz: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return wallTimeToUtcMs(y, m, d, 0, 0, tz)
}

// Overlapping and touching ranges collapse into one row: same blocking effect,
// far fewer rows to write, delete and re-read on every run.
function mergeBlocks(blocks: BusyBlock[]): BusyBlock[] {
  const sorted = [...blocks].sort((a, b) => a.startMs - b.startMs)
  const merged: BusyBlock[] = []
  for (const block of sorted) {
    const last = merged[merged.length - 1]
    if (last && block.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, block.endMs)
    } else {
      merged.push({ ...block })
    }
  }
  return merged
}

// Consecutive-failure counter read by the admin sync-health banner on the
// teacher Schedule page. A failed read floors the counter at 1 rather than
// guessing: under-counting only delays the banner, and the page's own settings
// read fails open to showing it anyway.
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
  const { error } = await supabase.from('settings').upsert(
    [
      { key: FAILURE_KEY, value: '0', updated_at: stamp },
      { key: LAST_SUCCESS_KEY, value: stamp, updated_at: stamp },
    ],
    { onConflict: 'key' }
  )
  if (error) {
    // The sync itself succeeded; a bookkeeping write failure must not be
    // reported as a sync failure, but it does need to be visible.
    console.error('[google-busy-sync] success-marker write failed:', error)
  }
}

async function fail(message: string): Promise<NextResponse> {
  console.error(`[google-busy-sync] ${message}`)
  const failures = await recordFailure(message)
  return NextResponse.json(
    { ok: false, blocksWritten: 0, rowsDeleted: 0, failures, error: message },
    { status: 500 }
  )
}

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  // Heartbeat: records that this cron FIRED (auth passed), not that it finished --
  // completed_at here is the fire time. cron_runs has UNIQUE (cron_name, run_date);
  // default upsert (ignoreDuplicates false) means sub-daily runs refresh completed_at
  // to the latest fire. Best-effort: a heartbeat failure must never abort the job.
  {
    const hbNow = new Date()
    const hbDate = `${hbNow.getUTCFullYear()}-${String(hbNow.getUTCMonth() + 1).padStart(2, '0')}-${String(hbNow.getUTCDate()).padStart(2, '0')}`
    const { error: hbErr } = await supabase
      .from('cron_runs')
      .upsert(
        { cron_name: 'google-busy-sync', run_date: hbDate, completed_at: hbNow.toISOString() },
        { onConflict: 'cron_name,run_date' }
      )
    if (hbErr) console.error('[heartbeat] cron_runs write failed:', hbErr)
  }

  // ── 1. Feed URL ────────────────────────────────────────────────────────────
  const icsUrl = process.env.GOOGLE_BUSY_ICS_URL?.trim()
  if (!icsUrl) {
    return fail('GOOGLE_BUSY_ICS_URL is not set — no calendar to sync')
  }

  // ── 2. Target account ──────────────────────────────────────────────────────
  // Never hardcoded: resolved every run, and required to be exactly one row.
  const { data: adminProfiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, timezone')
    .eq('role', 'admin')

  if (profileError) {
    return fail(`Admin profile lookup failed: ${profileError.message}`)
  }
  if (!adminProfiles || adminProfiles.length !== 1) {
    return fail(
      `Expected exactly 1 profile with role='admin', found ${adminProfiles?.length ?? 0}`
    )
  }

  const target = adminProfiles[0]
  const teacherTimezone: string | null = target.timezone
  if (!teacherTimezone || !isValidTimeZone(teacherTimezone)) {
    return fail(
      `Admin profile ${target.id} has no usable timezone (got ${JSON.stringify(teacherTimezone)})`
    )
  }

  // ── 3. Window ──────────────────────────────────────────────────────────────
  const windowStartMs = Date.now()
  const windowEndMs = windowStartMs + WINDOW_DAYS * 24 * 60 * 60 * 1000
  const windowStart = new Date(windowStartMs)
  const windowEnd = new Date(windowEndMs)

  // ── 4. Fetch the feed ──────────────────────────────────────────────────────
  let icsText: string
  try {
    const response = await fetch(icsUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/calendar' },
      cache: 'no-store',
    })
    if (!response.ok) {
      return fail(`ICS fetch returned HTTP ${response.status}`)
    }
    icsText = await response.text()
  } catch (err) {
    return fail(`ICS fetch failed: ${errorMessage(err)}`)
  }

  // ── 5. Parse + expand into busy blocks ─────────────────────────────────────
  // One try/catch over the whole conversion, deliberately: a throw here returns
  // BEFORE the write path, so the previous run's rows survive untouched. That
  // leaves the teacher over-blocked (safe) instead of writing a partial picture
  // and deleting the rows that were covering the gap.
  const blocks: BusyBlock[] = []
  try {
    const parsed = await ical.async.parseICS(icsText)

    for (const component of Object.values(parsed)) {
      if (!isVEvent(component)) continue
      // Series-level skip: a master marked free/cancelled takes its whole
      // series (and its overrides) with it.
      if (isNonBlocking(component)) continue

      const instances: EventInstance[] = ical.expandRecurringEvent(component, {
        from: windowStart,
        to: windowEnd,
        // An event that began before now but is still running has to block the
        // remainder of itself, so ongoing instances must be expanded too.
        expandOngoing: true,
      })

      for (const instance of instances) {
        // instance.event is the RECURRENCE-ID override where one exists, so a
        // single occurrence cancelled or marked free is dropped on its own.
        if (isNonBlocking(instance.event)) continue

        let startMs: number
        let endMs: number

        if (instance.isFullDay) {
          const startKey = localDateKey(instance.start)
          let endKey = localDateKey(instance.end)
          // DTEND of an all-day event is exclusive; a feed that omits or
          // mangles it falls back to a single day rather than a zero-width
          // block that would silently stop blocking anything.
          if (endKey <= startKey) endKey = addDaysToDateKey(startKey, 1)
          startMs = zoneMidnightUtcMs(startKey, teacherTimezone)
          endMs = zoneMidnightUtcMs(endKey, teacherTimezone)
        } else {
          startMs = instance.start.getTime()
          endMs = instance.end.getTime()
        }

        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue

        // Clamp to the window; anything left with no width is fully outside it.
        const clampedStart = Math.max(startMs, windowStartMs)
        const clampedEnd = Math.min(endMs, windowEndMs)
        if (clampedEnd <= clampedStart) continue

        blocks.push({ startMs: clampedStart, endMs: clampedEnd })
      }
    }
  } catch (err) {
    return fail(`ICS parse/expand failed: ${errorMessage(err)}`)
  }

  const merged = mergeBlocks(blocks)

  // ── 6. Write: insert BEFORE delete ─────────────────────────────────────────
  // Deliberate ordering. A crash between the two steps leaves both generations
  // of rows in place — duplicate blocks over-block, which costs a bookable slot
  // and nothing else, and the next run clears them. Delete-first would open a
  // window where her Google commitments block nothing at all.

  // 6a. Snapshot the rows this run is replacing. Scoped to source='google_sync'
  // and to this teacher: manual availability is never selected, so it can never
  // be deleted below. No time filter — a window-bounded select never caught
  // rows that had already fully elapsed, so every run orphaned yesterday's
  // blocks permanently. Selecting every sync-owned row makes each run fully
  // replace the previous generation.
  const { data: existingRows, error: existingError } = await supabase
    .from('availability')
    .select('id')
    .eq('teacher_id', target.id)
    .eq('source', 'google_sync')

  if (existingError) {
    return fail(`Existing block lookup failed: ${existingError.message}`)
  }

  const staleIds: string[] = (existingRows ?? []).map((row) => row.id)

  // 6b. Insert the new generation. day_of_week/start_time/end_time stay NULL:
  // the slot engine and booking gate read a `specific` row with is_available
  // false and both instants populated as a timed block.
  if (merged.length > 0) {
    const { error: insertError } = await supabase.from('availability').insert(
      merged.map((block) => ({
        teacher_id: target.id,
        type: 'specific',
        is_available: false,
        source: 'google_sync',
        start_at: new Date(block.startMs).toISOString(),
        end_at: new Date(block.endMs).toISOString(),
        day_of_week: null,
        start_time: null,
        end_time: null,
      }))
    )

    if (insertError) {
      // No delete on a failed insert — the old rows are all the blocking cover
      // that is left.
      return fail(`Block insert failed: ${insertError.message}`)
    }
  }

  // 6c. Delete the previous generation by the ids captured in 6a.
  let rowsDeleted = 0
  let warning: string | undefined

  for (let i = 0; i < staleIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = staleIds.slice(i, i + DELETE_CHUNK_SIZE)
    const { error: deleteError } = await supabase
      .from('availability')
      .delete()
      .in('id', chunk)

    if (deleteError) {
      console.error('[google-busy-sync] stale block delete failed:', deleteError)
      warning = `Inserted ${merged.length} block(s) but failed to delete ${
        staleIds.length - rowsDeleted
      } superseded row(s): ${errorMessage(deleteError.message)}. They over-block until the next run clears them.`
      break
    }
    rowsDeleted += chunk.length
  }

  // A failed delete leaves duplicates, which is the safe direction — the run
  // still counts as a success and the counter resets.
  await recordSuccess()

  return NextResponse.json({
    ok: true,
    blocksWritten: merged.length,
    rowsDeleted,
    failures: 0,
    ...(warning ? { warning } : {}),
  })
}
