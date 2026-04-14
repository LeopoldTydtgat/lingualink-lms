import { createAdminClient } from '@/lib/supabase/admin'

export async function checkRateLimit(
  ip: string,
  portal: 'teacher' | 'student'
): Promise<boolean> {
  try {
    const supabase = createAdminClient()
    const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    const [{ count }, _insert] = await Promise.all([
      supabase
        .from('login_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('ip_address', ip)
        .eq('portal', portal)
        .gte('attempted_at', windowStart)
        .then((r) => ({ count: r.count ?? 0 })),
      supabase
        .from('login_attempts')
        .insert({ ip_address: ip, portal }),
    ])

    return count >= 4
  } catch {
    return false
  }
}
