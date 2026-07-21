import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * THE canonical admin rule — the single source of truth shared by the (admin)
 * layout, the admin pages, and every /api/admin route:
 *
 *   isAdmin = role === 'admin'
 *
 * Use this predicate directly when the caller already fetched the profile row
 * it needs anyway (layout, pages); use requireAdmin() when the profile would
 * be fetched solely to authorise. Staff-permitted routes use requireStaff()
 * (role 'admin' OR account_types contains 'staff') instead — see
 * src/lib/auth/requireStaff.ts.
 */
export function isAdminProfile(
  profile: { role?: string | null; account_types?: string[] | null } | null | undefined
): boolean {
  return profile?.role === 'admin'
}

/**
 * Resolves the caller and returns them only if they are an admin.
 *
 * Applies the canonical rule above. Returns null for anonymous callers
 * AND for non-admins, so the
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
    .select('id, role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  return isAdminProfile(profile) ? user : null
}
