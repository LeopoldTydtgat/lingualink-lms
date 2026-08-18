import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

/**
 * Request-memoised resolution of "who is calling", shared by requireAdmin(),
 * requireStaff() and requireTeacher().
 *
 * Before this module each of those three gates opened its own Supabase client,
 * called auth.getUser() and read profiles independently, so a page that gated
 * twice (a layout plus its page, or a page calling two gates) paid for the same
 * auth round trip and the same profiles row twice. The two expensive parts - the
 * auth round trip and the profiles row - are memoised with React's `cache`, so
 * within one server render each happens once.
 *
 * createClient() IS DELIBERATELY NOT MEMOISED. CLAUDE.md:119 - "Never wrap
 * `createClient` in React's `cache()` - it crashes all server components" - and
 * the incident behind it is JOURNAL.md:4279-4283: every page returned `---` (no
 * response) on Vercel once `createClient` was wrapped in `cache()` inside
 * server.ts, and the recorded cause ("conflicted with the Supabase SSR client's
 * cookie handling in Next.js 16's server component lifecycle") is a symptom, not
 * a mechanism. The fix was a straight revert, so the real cause is still
 * unknown. Creating the client is local work anyway - a cookies() read, a
 * headers() read and object construction, no network - so memoising it would buy
 * almost nothing against an unexplained production outage. Each function below
 * calls createClient() itself.
 *
 * RESIDUAL, UNTESTED EXPOSURE: the memo callbacks below still invoke
 * createClient() *inside* a React cache scope, so if the April mechanism was
 * cookie access within a cache scope rather than the cached client instance
 * itself, this module is still exposed. Nothing here reproduces or rules that
 * out. Before this reaches main, smoke-test a Vercel preview: load an admin page
 * (RSC path, hits requireStaff) and call a gated API route (route-handler path),
 * and confirm neither returns `---`.
 *
 * PER-REQUEST MEMO AT BEST, NO MEMO AT WORST, NEVER CROSS-REQUEST. React's
 * `cache` stores its memo on the current render's cache scope, which is scoped
 * to a single server request and torn down with it; two concurrent requests, and
 * therefore two different users, can never observe each other's value. Where no
 * cache scope exists - route handlers and server-action bodies, which do not run
 * inside a React render - `cache` calls straight through to the function
 * (react.react-server: `if (!dispatcher) return fn.apply(null, arguments)`).
 * That is not a failure: those callers simply behave exactly as they did before
 * this module existed, one client and one read each. Do not "upgrade" these to
 * `unstable_cache` or `"use cache"` to chase that saving - both are real caches
 * keyed independently of the session cookie, both would leak one caller's
 * identity to another, and both forbid the dynamic cookie read this needs.
 *
 * THE THROW/NULL SPLIT IS DELIBERATE AND EVERY CALLER MUST PRESERVE IT:
 *   - No session            -> { user: null, profile: null }. Anonymous. Gates
 *                              return null (denied).
 *   - Session, no row       -> { user, profile: null }. A confirmed-empty read:
 *                              the caller genuinely has no profile, so they hold
 *                              no role. Gates return null (denied).
 *   - profiles read FAILED  -> throws. A failed read says NOTHING about the
 *                              caller's role. Swallowing it would silently
 *                              demote a real admin on a transient DB error, so
 *                              it must propagate out of every gate. Never wrap a
 *                              getCallerProfile() call in a try/catch that
 *                              converts the throw into a denial.
 *
 * A memoised rejection is shared for the rest of the request, so a request that
 * gates twice no longer gets a second, independent attempt at the profiles read:
 * one transient failure now fails the whole request instead of being survived by
 * the retry. That moves in the fail-closed direction - it can turn a lucky retry
 * into a 500, never a denial into an approval - and it is the intended trade for
 * making both gates agree on one answer.
 *
 * COLUMN LIST: 'id, role, account_types, status' is exactly the union of what
 * the three gates need (admin: role+status; staff: role+account_types+status;
 * teacher: account_types+status). It is read with the RLS-scoped session client,
 * never the service-role client, so the caller only ever sees their own row.
 * Widening this list is not free: check the table's column-level GRANT/REVOKE
 * state first, because a revoked column turns this shared read - and therefore
 * every gate in the app - into a hard 42501 failure.
 *
 * Server-only - it reads the session cookie. Never import into a client component.
 */

/** The profiles columns every gate authorises on. Untyped client, so declared here. */
export type CallerProfile = {
  id: string
  role: string | null
  account_types: string[] | null
  status: string | null
}

/** The authenticated user for this request, or null when anonymous. */
export const getCallerUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})

/**
 * The caller's user and profiles row for this request.
 *
 * Throws on a failed profiles read - see the throw/null split above.
 */
export const getCallerProfile = cache(
  async (): Promise<{ user: User | null; profile: CallerProfile | null }> => {
    const user = await getCallerUser()
    if (!user) return { user: null, profile: null }

    const supabase = await createClient()
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, role, account_types, status')
      .eq('id', user.id)
      .maybeSingle()

    if (error) {
      console.error('[callerProfile] profiles lookup failed:', error)
      throw new Error('Failed to load profile')
    }

    return { user, profile }
  }
)
