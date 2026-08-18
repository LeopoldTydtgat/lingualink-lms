import { getCallerProfile } from '@/lib/auth/callerProfile'
import type { User } from '@supabase/supabase-js'

/**
 * Resolves the caller and returns them only if they may perform staff-level
 * operations: class management, teacher-student assignment, schedules,
 * availability, hours-balance viewing, support answering. NOT billing,
 * invoices, settings, exports, tasks, account creation, or library admin —
 * those stay behind requireAdmin().
 *
 * Authorised = role === 'admin' (the school owner) OR account_types contains
 * 'staff', AND status === 'current' (the canonical active-account gate).
 *
 * Returns null for anonymous callers AND for non-staff, so the caller cannot
 * accidentally treat "logged in" as "authorised".
 *
 * Fail-closed: a confirmed-empty profiles read yields no profile, which is not
 * staff. A profiles read that FAILS is not the same thing — it says nothing
 * about the caller's role, so it throws rather than silently demoting a valid
 * admin to non-staff on a transient DB error.
 *
 * The user and profile come from getCallerProfile(), so the auth call and the
 * profiles read are request-memoised and shared with the other gates — see
 * src/lib/auth/callerProfile.ts.
 *
 * Server-only — it reads the session cookie. Never import into a client component.
 */
export async function requireStaff(): Promise<User | null> {
  const { user, profile } = await getCallerProfile()
  if (!user) return null

  const isStaff =
    profile?.status === 'current' &&
    (profile.role === 'admin' ||
      (Array.isArray(profile.account_types) && profile.account_types.includes('staff')))

  return isStaff ? user : null
}
