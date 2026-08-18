import { getCallerProfile, type CallerProfile } from '@/lib/auth/callerProfile'
import type { User } from '@supabase/supabase-js'

/**
 * THE canonical staff rule, as a pure predicate:
 *
 *   isStaffProfile = status === 'current'
 *                    AND (role === 'admin' OR account_types contains 'staff')
 *
 * Pure — no I/O, no session read, no DB access. requireStaff() below is the
 * GATE (it resolves the caller, then applies this); this function is only the
 * RULE. They share this one definition so no caller can drift into a private
 * copy of it.
 *
 * requireStaff() collapses "anonymous" and "authenticated but not staff" into
 * the same null. Callers that must distinguish the two pair this predicate with
 * getCallerProfile() instead of calling requireStaff(): the user says whether
 * there is a session at all, this says whether that session is staff.
 */
export function isStaffProfile(profile: CallerProfile | null): boolean {
  return (
    profile?.status === 'current' &&
    (profile.role === 'admin' ||
      (Array.isArray(profile.account_types) &&
        profile.account_types.includes('staff')))
  )
}

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
 * The rule itself lives in isStaffProfile() above — this is only the gate.
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

  return isStaffProfile(profile) ? user : null
}
