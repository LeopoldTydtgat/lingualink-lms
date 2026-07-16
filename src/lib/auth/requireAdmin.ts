import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * Resolves the caller and returns them only if they are an admin.
 *
 * Mirrors the inline gate used across /api/admin routes (and the local copy in
 * library/upload/route.ts): `role = 'admin'` OR `account_types` containing
 * 'school_admin'. Returns null for anonymous callers AND for non-admins, so the
 * caller cannot accidentally treat "logged in" as "authorised".
 *
 * Fail-closed: a failed profiles read yields no profile, which is not an admin.
 *
 * Server-only — it reads the session cookie. Never import into a client component.
 */
export async function requireAdmin(): Promise<User | null> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  return isAdmin ? user : null
}
