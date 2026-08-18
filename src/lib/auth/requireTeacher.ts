import { getCallerProfile } from '@/lib/auth/callerProfile'
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
 * Mirrors requireAdmin's contract - fail-closed, null on denial, throw on a
 * failed profiles read - with one deliberate addition: it also returns the
 * user-scoped Supabase client it created. Teacher library writes are gated by
 * RLS itself (owner_id = auth.uid() AND audience = 'staff' on study_sheets), so
 * callers MUST perform those writes through this exact session client - never
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
 * Fail-closed: a confirmed-empty profiles read yields no profile, which is not
 * a teacher. A profiles read that FAILS is not the same thing - it says nothing
 * about the caller's role, so it throws rather than silently demoting a current
 * teacher on a transient DB error (which callers would report as a misleading
 * 401 Unauthorised).
 *
 * The user and profile come from getCallerProfile(), so the auth call and the
 * profiles read are request-memoised and shared with the other gates - see
 * src/lib/auth/callerProfile.ts. The returned client is still created here by
 * createClient(), which is deliberately never memoised (CLAUDE.md:119,
 * JOURNAL.md:4279-4283); it is the caller's own RLS-scoped session client,
 * reading the same session cookie the gate authorised on.
 *
 * Server-only - it reads the session cookie. Never import into a client component.
 */
export async function requireTeacher(): Promise<TeacherAuth | null> {
  const { user, profile } = await getCallerProfile()
  if (!user) return null

  const supabase = await createClient()

  const isCurrentTeacher =
    profile?.status === 'current' &&
    Array.isArray(profile?.account_types) &&
    (profile.account_types.includes('teacher') || profile.account_types.includes('teacher_exam'))

  return isCurrentTeacher ? { user, supabase } : null
}
