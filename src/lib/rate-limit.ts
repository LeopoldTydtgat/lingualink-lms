/**
 * Simple in-memory rate limiter for login endpoints.
 *
 * Tracks failed attempts per IP address. On Vercel, each serverless function
 * instance has its own memory space, so this is per-instance rather than
 * globally coordinated. For this application's scale (50 students, 3 teachers)
 * this is sufficient. Supabase Auth's own rate limiting provides a second layer.
 *
 * AWS migration note: replace this module with an Elasticache (Redis) call
 * using the same interface to get coordinated rate limiting across instances.
 */

const MAX_ATTEMPTS = 5          // failed attempts before lockout
const WINDOW_MS = 15 * 60_000  // 15-minute sliding window
const LOCKOUT_MS = 15 * 60_000 // 15-minute lockout

interface AttemptRecord {
  count: number
  windowStart: number
  lockedUntil: number | null
}

// Module-level store — persists for the lifetime of the function instance
const attempts = new Map<string, AttemptRecord>()

/**
 * Returns the client IP from Next.js request headers.
 * Falls back to 'unknown' if no IP header is present.
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    headers.get('x-real-ip') ??
    'unknown'
  )
}

/**
 * Check whether this IP is currently rate limited.
 * Returns an error string if blocked, or null if the request can proceed.
 */
export function checkRateLimit(ip: string): string | null {
  const now = Date.now()
  const record = attempts.get(ip)

  if (!record) return null

  // Active lockout
  if (record.lockedUntil && now < record.lockedUntil) {
    const minutesLeft = Math.ceil((record.lockedUntil - now) / 60_000)
    return `Too many failed login attempts. Please try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`
  }

  // Window has expired — reset
  if (now - record.windowStart > WINDOW_MS) {
    attempts.delete(ip)
    return null
  }

  return null
}

/**
 * Record a failed login attempt for this IP.
 * Triggers a lockout if MAX_ATTEMPTS is reached.
 */
export function recordFailedAttempt(ip: string): void {
  const now = Date.now()
  const record = attempts.get(ip)

  if (!record || now - record.windowStart > WINDOW_MS) {
    // Start a new window
    attempts.set(ip, { count: 1, windowStart: now, lockedUntil: null })
    return
  }

  const newCount = record.count + 1

  if (newCount >= MAX_ATTEMPTS) {
    attempts.set(ip, {
      count: newCount,
      windowStart: record.windowStart,
      lockedUntil: now + LOCKOUT_MS,
    })
  } else {
    attempts.set(ip, {
      count: newCount,
      windowStart: record.windowStart,
      lockedUntil: null,
    })
  }
}

/**
 * Clear the attempt record for this IP on successful login.
 */
export function clearAttempts(ip: string): void {
  attempts.delete(ip)
}
