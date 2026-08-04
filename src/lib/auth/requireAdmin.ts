import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * ROLE-ONLY predicate:
 *
 *   isAdminProfile = role === 'admin'
 *
 * It says NOTHING about whether the account is still active, so it is safe only
 * where the caller has ALREADY gated profiles.status = 'current' by other means.
 * The one place that holds today is a page under the (admin) route group: its
 * layout calls requireStaff() (role 'admin' OR account_types contains 'staff',
 * AND status 'current') before any page in the group renders.
 *
 * Anywhere that upstream gate is absent - every /api/admin route handler, since
 * no layout wraps a route handler - use requireAdmin() below instead. That
 * helper applies the FULL rule, role AND status. Staff-permitted routes use
 * requireStaff() (role 'admin' OR account_types contains 'staff') instead, see
 * src/lib/auth/requireStaff.ts.
 */
export function isAdminProfile(
  profile: { role?: string | null; account_types?: string[] | null } | null | undefined
): boolean {
  return profile?.role === 'admin'
}

/**
 * Resolves the caller and returns them only if they are a CURRENT admin.
 *
 * THE canonical admin rule, the single source of truth for every caller that
 * authorises through this helper:
 *
 *   isCurrentAdmin = role === 'admin' AND status === 'current'
 *
 * status is the canonical active-account gate, matching requireStaff() and
 * requireTeacher(). A deactivated admin (status 'former' or 'on_hold') is
 * refused here even though their role is unchanged: proxy.ts now status-gates
 * every request unconditionally, so this helper's status check is defence-in-
 * depth for route handlers, which must never rely on the proxy alone.
 *
 * Returns null for anonymous callers, for non-admins, AND for admins who are no
 * longer current, so the caller cannot accidentally treat "logged in" as
 * "authorised".
 *
 * Fail-closed: a confirmed-empty profiles read yields no profile, which is not
 * an admin. A profiles read that FAILS is not the same thing - it says nothing
 * about the caller's role, so it throws rather than silently demoting a real
 * admin on a transient DB error.
 *
 * Server-only - it reads the session cookie. Never import into a client component.
 */
export async function requireAdmin(): Promise<User | null> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, role, status')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[requireAdmin] profiles lookup failed:', error)
    throw new Error('Failed to load profile')
  }

  const isCurrentAdmin =
    profile?.status === 'current' && isAdminProfile(profile)

  return isCurrentAdmin ? user : null
}
