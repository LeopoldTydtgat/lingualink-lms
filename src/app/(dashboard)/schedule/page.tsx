import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { isValidTimeZone, utcInstantToTzParts } from '@/lib/utils/timezone'
import ScheduleClient from './ScheduleClient'
import type { GoogleConnectionSummary, GoogleNotice } from './GoogleConnectCard'

// ── Google busy-sync health ──────────────────────────────────────────────────
// Single-user feature: only the admin teacher's Google calendar is mirrored, so
// only she is shown its health. Keys are written by
// src/app/api/cron/google-busy-sync/route.ts.
const SYNC_FAILURE_KEY = 'google_busy_sync_failures'
const SYNC_LAST_ERROR_KEY = 'google_busy_sync_last_error'
const SYNC_LAST_SUCCESS_KEY = 'google_busy_sync_last_success_at'

// Banner threshold: 3 consecutive failed cron runs; the counter resets to 0 on the first success.
const SYNC_FAILURE_THRESHOLD = 3

const SYNC_UNKNOWN_WARNING =
  'Google Calendar sync health could not be checked. Your Google events may not be blocking bookings.'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Fixed-format, timezone-explicit date. Computed on the server and handed to the
// client as a finished string, so there is no locale/clock split to hydrate.
function formatDateInZone(iso: string, timezone: string): string | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const tz = isValidTimeZone(timezone) ? timezone : 'UTC'
  const parts = utcInstantToTzParts(new Date(ms), tz)
  return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`
}

interface PageProps {
  // Next.js 16 — searchParams is a Promise, must be awaited.
  // ?google= is written by the two OAuth routes under /api/google/oauth/.
  searchParams: Promise<{ google?: string }>
}

export default async function SchedulePage({ searchParams }: PageProps) {
  // OAuth round-trip outcome, reduced to success/error HERE so the raw code
  // ('token_error', 'state_error', ...) stays a server-log detail and never
  // becomes user-facing copy. Anything that is not 'connected' is a failure,
  // which keeps every future outcome code covered by default.
  const { google: googleOutcome } = await searchParams
  const googleNotice: GoogleNotice =
    googleOutcome === 'connected'
      ? 'success'
      : typeof googleOutcome === 'string' && googleOutcome.length > 0
        ? 'error'
        : null

  const supabase = await createClient()

  // Check the user is logged in
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get the teacher's profile so we know their role and id
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, timezone, profile_completed')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  if (profile.profile_completed !== true) {
    redirect('/account?confirm_tz=1')
  }

  // Fetch existing availability for this teacher
  const { data: availability } = await supabase
    .from('availability')
    .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available, source')
    .eq('teacher_id', profile.id)
    .order('start_at', { ascending: true })

  // Minimum-hours target from settings (service-role admin client). Fail SAFE:
  // any missing/non-numeric value degrades to null — never invent a target.
  const admin = createAdminClient()
  const { data: minHoursRow } = await admin
    .from('settings')
    .select('value')
    .eq('key', 'min_available_hours')
    .single()
  const parsedMinHours = Number(minHoursRow?.value)
  const minAvailableHours = Number.isNaN(parsedMinHours) ? null : parsedMinHours

  // Sync-health banner — admin viewer only, so every other teacher skips the read.
  let googleSyncWarning: string | null = null

  if (profile.role === 'admin') {
    const { data: syncRows, error: syncError } = await admin
      .from('settings')
      .select('key, value')
      .in('key', [SYNC_FAILURE_KEY, SYNC_LAST_ERROR_KEY, SYNC_LAST_SUCCESS_KEY])

    if (syncError) {
      console.error('[schedule] google busy-sync health read failed:', syncError)
      // Fail SAFE: an unreadable counter is not evidence the sync is healthy, so
      // the null path prompts action instead of hiding a possible outage.
      googleSyncWarning = SYNC_UNKNOWN_WARNING
    } else {
      const values = new Map<string, string | null>(
        (syncRows ?? []).map((row) => [row.key, row.value])
      )
      const rawFailures = values.get(SYNC_FAILURE_KEY)

      if (rawFailures !== undefined) {
        // Row absent (undefined) means the cron has never reported yet — that is
        // not a failure signal. A row holding a null/garbage value is, because
        // only this cron writes the key.
        const failures = Number.parseInt(rawFailures ?? '', 10)

        if (!Number.isFinite(failures)) {
          googleSyncWarning = SYNC_UNKNOWN_WARNING
        } else if (failures >= SYNC_FAILURE_THRESHOLD) {
          const lastSuccessRaw = values.get(SYNC_LAST_SUCCESS_KEY)
          const since =
            (lastSuccessRaw ? formatDateInZone(lastSuccessRaw, profile.timezone) : null) ??
            'an unknown time'
          const lastError = values.get(SYNC_LAST_ERROR_KEY)
          googleSyncWarning =
            `Google Calendar sync has been failing since ${since}. ` +
            `Your Google events may not be blocking bookings.` +
            (lastError ? ` ${lastError}` : '')
        }
      }
    }
  }

  // Google Calendar connect card. Admin viewer only, exactly like the banner
  // above: every other teacher skips the read AND is handed null, which is what
  // makes the card ABSENT for them rather than merely disabled.
  //
  // public.google_calendar_connections is deny-all to anon/authenticated (RLS
  // with zero policies + REVOKE), so this read has to go through the
  // service-role client.
  //
  // EXPLICIT COLUMN LIST, AND DELIBERATELY NOT THE TOKEN COLUMNS: refresh_token,
  // access_token and access_token_expires_at are never selected here, so nothing
  // token-shaped exists in this scope to be handed to a client component by
  // accident.
  let googleConnection: GoogleConnectionSummary | null = null

  if (profile.role === 'admin') {
    const { data: connectionRow, error: connectionError } = await admin
      .from('google_calendar_connections')
      .select('id, google_email')
      .eq('profile_id', profile.id)
      .maybeSingle()

    if (connectionError) {
      console.error('[schedule] google calendar connection read failed:', connectionError)
      // Fail SAFE: an unreadable row is not evidence of a working connection, so
      // prompt for the action rather than claim one already exists.
      googleConnection = { connected: false, email: null }
    } else {
      googleConnection = {
        connected: connectionRow !== null,
        email: connectionRow?.google_email ?? null,
      }
    }
  }

  return (
    <ScheduleClient
      profile={profile}
      initialAvailability={availability ?? []}
      minAvailableHours={minAvailableHours}
      googleSyncWarning={googleSyncWarning}
      googleConnection={googleConnection}
      googleNotice={googleNotice}
    />
  )
}
