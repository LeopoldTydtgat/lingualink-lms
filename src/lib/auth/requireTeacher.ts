import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

export type TeacherAuth = {
  user: User
  supabase: ServerSupabase
}

/**
 * Resolves the caller and returns them only if they are a *current* teacher.
 *
 * Mirrors requireAdmin's fail-closed, null-on-denial contract, with one
 * deliberate addition: it also returns the user-scoped Supabase client it
 * created. Teacher library writes are gated by RLS itself
 * (owner_id = auth.uid() AND audience = 'staff' on study_sheets), so callers
 * MUST perform those writes through this exact session client - never
 * createAdminClient, which would bypass the very policy that enforces the
 * design. Returning the client here removes any chance a route reaches for the
 * wrong one. requireAdmin does not do this because its callers deliberately use
 * the service-role client to bypass RLS; teachers are the opposite case.
 *
 * Authorised = a profiles row whose account_types contains 'teacher' or
 * 'teacher_exam' AND whose status = 'current'. Returns null for anonymous
 * callers and for anyone who is not a current teacher, so "logged in" can never
 * be mistaken for "authorised".
 *
 * Fail-closed: a failed profiles read yields no profile, which is not a
 * teacher, so the result is null.
 *
 * Server-only - it reads the session cookie. Never import into a client component.
 */
export async function requireTeacher(): Promise<TeacherAuth | null> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types, status')
    .eq('id', user.id)
    .maybeSingle()

  const isCurrentTeacher =
    profile?.status === 'current' &&
    Array.isArray(profile?.account_types) &&
    (profile.account_types.includes('teacher') || profile.account_types.includes('teacher_exam'))

  return isCurrentTeacher ? { user, supabase } : null
}
