import { createAdminClient } from '@/lib/supabase/admin'

const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

export type RateLimitResult = {
  blocked: boolean
  retryAfterSeconds: number
}

export async function checkRateLimit(
  ip: string,
  portal: 'teacher' | 'student'
): Promise<RateLimitResult> {
  try {
    const supabase = createAdminClient()
    const windowStart = new Date(Date.now() - WINDOW_MS).toISOString()

    // Step 1: count attempts in the current window
    const { data: attempts, error } = await supabase
      .from('login_attempts')
      .select('attempted_at')
      .eq('ip_address', ip)
      .eq('portal', portal)
      .gte('attempted_at', windowStart)
      .order('attempted_at', { ascending: true })

    if (error) {
      // FAIL CLOSED (M-20). The login rate limiter previously failed open on
      // a DB error, which meant a forced DB outage would silently disable
      // brute-force protection. Treat read failure as a 60s lockout instead.
      console.error('[checkRateLimit] DB read failed; failing closed:', error)
      return { blocked: true, retryAfterSeconds: 60 }
    }

    const count = attempts?.length ?? 0

    // Step 2: if at or over the limit, block and compute retry time
    if (count >= MAX_ATTEMPTS) {
      const oldest = attempts![0].attempted_at
      const oldestMs = new Date(oldest).getTime()
      const retryAfterMs = oldestMs + WINDOW_MS - Date.now()
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
      return { blocked: true, retryAfterSeconds }
    }

    // Step 3: record this attempt (sequenced after the count, no race)
    const { error: insertError } = await supabase
      .from('login_attempts')
      .insert({ ip_address: ip, portal })

    if (insertError) {
      // Fail closed if we can't even record the attempt — same reasoning.
      console.error('[checkRateLimit] DB insert failed; failing closed:', insertError)
      return { blocked: true, retryAfterSeconds: 60 }
    }

    return { blocked: false, retryAfterSeconds: 0 }
  } catch (err) {
    console.error('[checkRateLimit] Unexpected error; failing closed:', err)
    return { blocked: true, retryAfterSeconds: 60 }
  }
}

export async function clearRateLimit(
  ip: string,
  portal: 'teacher' | 'student'
): Promise<void> {
  try {
    const supabase = createAdminClient()
    await supabase
      .from('login_attempts')
      .delete()
      .eq('ip_address', ip)
      .eq('portal', portal)
  } catch {
    // Silent — clearing is best-effort
  }
}

// ── Student booking rate limit ────────────────────────────────────────────────
// Per-student limit on /api/student/book to stop a single compromised session
// from draining hours, exhausting the Teams API quota, or spamming Resend.
// Uses students.id (stable across IP changes) instead of IP. Backed by a
// dedicated booking_attempts table — see SQL block in the security review notes.
//
// FAILS CLOSED on DB error (intentional reversal of the login rate limiter
// which fails open). A booking is a write operation that costs hours, money,
// and external API calls — denying on DB blip is safer than letting abuse through.

const BOOKING_WINDOW_MS = 60 * 60 * 1000
const BOOKING_MAX_ATTEMPTS = 10

export async function checkStudentBookingLimit(
  studentId: string
): Promise<RateLimitResult> {
  try {
    const supabase = createAdminClient()
    const windowStart = new Date(Date.now() - BOOKING_WINDOW_MS).toISOString()

    const { data: attempts, error } = await supabase
      .from('booking_attempts')
      .select('attempted_at')
      .eq('student_id', studentId)
      .gte('attempted_at', windowStart)
      .order('attempted_at', { ascending: true })

    if (error) {
      // Fail closed — see comment above.
      return { blocked: true, retryAfterSeconds: 60 }
    }

    const count = attempts?.length ?? 0

    if (count >= BOOKING_MAX_ATTEMPTS) {
      const oldest = attempts![0].attempted_at
      const oldestMs = new Date(oldest).getTime()
      const retryAfterMs = oldestMs + BOOKING_WINDOW_MS - Date.now()
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
      return { blocked: true, retryAfterSeconds }
    }

    const { error: insertError } = await supabase
      .from('booking_attempts')
      .insert({ student_id: studentId })

    if (insertError) {
      // Fail closed.
      return { blocked: true, retryAfterSeconds: 60 }
    }

    return { blocked: false, retryAfterSeconds: 0 }
  } catch {
    return { blocked: true, retryAfterSeconds: 60 }
  }
}

// ── Generic per-user action rate limit ───────────────────────────────────────
// Backs M-18 (email dispatch) and M-19 (admin hours mutations). Stored in a
// single `user_action_attempts` table — see the SQL block printed in the
// medium-severity batch notes. Like the booking limit, this FAILS CLOSED on
// DB error: we'd rather drop a legitimate request than let abuse through
// during a DB blip.

type ActionBucket = 'email_dispatch' | 'admin_hours_mutation'

async function checkUserActionLimit(
  userId: string,
  bucket: ActionBucket,
  maxAttempts: number,
  windowMs: number,
): Promise<RateLimitResult> {
  try {
    const supabase = createAdminClient()
    const windowStart = new Date(Date.now() - windowMs).toISOString()

    const { data: attempts, error } = await supabase
      .from('user_action_attempts')
      .select('attempted_at')
      .eq('user_id', userId)
      .eq('bucket', bucket)
      .gte('attempted_at', windowStart)
      .order('attempted_at', { ascending: true })

    if (error) {
      console.error(`[${bucket}] DB read failed; failing closed:`, error)
      return { blocked: true, retryAfterSeconds: 60 }
    }

    const count = attempts?.length ?? 0
    if (count >= maxAttempts) {
      const oldest = attempts![0].attempted_at
      const oldestMs = new Date(oldest).getTime()
      const retryAfterMs = oldestMs + windowMs - Date.now()
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
      return { blocked: true, retryAfterSeconds }
    }

    const { error: insertError } = await supabase
      .from('user_action_attempts')
      .insert({ user_id: userId, bucket })

    if (insertError) {
      console.error(`[${bucket}] DB insert failed; failing closed:`, insertError)
      return { blocked: true, retryAfterSeconds: 60 }
    }

    return { blocked: false, retryAfterSeconds: 0 }
  } catch (err) {
    console.error(`[${bucket}] Unexpected error; failing closed:`, err)
    return { blocked: true, retryAfterSeconds: 60 }
  }
}

// 20 outbound notification emails per user per hour. Caps the blast radius of
// a compromised teacher/admin session that loops over students.
export function checkEmailDispatchLimit(userId: string): Promise<RateLimitResult> {
  return checkUserActionLimit(userId, 'email_dispatch', 20, 60 * 60 * 1000)
}

// 50 hours add/deduct mutations per admin per hour. Caps the blast radius of
// a compromised admin session that scripts mass hour adjustments.
export function checkAdminHoursMutationLimit(userId: string): Promise<RateLimitResult> {
  return checkUserActionLimit(userId, 'admin_hours_mutation', 50, 60 * 60 * 1000)
}
