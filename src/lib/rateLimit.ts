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
      // Fail open on DB error
      return { blocked: false, retryAfterSeconds: 0 }
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
    await supabase.from('login_attempts').insert({ ip_address: ip, portal })

    return { blocked: false, retryAfterSeconds: 0 }
  } catch {
    return { blocked: false, retryAfterSeconds: 0 }
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
