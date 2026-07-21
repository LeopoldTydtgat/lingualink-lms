import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * Resolves the caller and returns them only if they may perform staff-level
 * operations: class management, teacher-student assignment, schedules,
 * availability, hours-balance viewing. NOT billing, invoices, settings,
 * exports, tasks, account creation, or library admin — those stay behind
 * requireAdmin().
 *
 * Authorised = role === 'admin' (the client's own account) OR account_types
 * contains 'staff', AND status === 'current' (the canonical active-account
 * gate). Deliberately narrower than requireAdmin(): 'school_admin' does NOT
 * pass here — school_admin accounts hold role 'admin' and pass via that arm.
 *
 * Returns null for anonymous callers AND for non-staff, so the caller cannot
 * accidentally treat "logged in" as "authorised".
 *
 * Fail-closed: a failed or empty profiles read yields no profile, which is
 * not staff.
 *
 * Server-only — it reads the session cookie. Never import into a client component.
 */
export async function requireStaff(): Promise<User | null> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, account_types, status')
    .eq('id', user.id)
    .maybeSingle()

  const isStaff =
    profile?.status === 'current' &&
    (profile.role === 'admin' ||
      (Array.isArray(profile.account_types) && profile.account_types.includes('staff')))

  return isStaff ? user : null
}
