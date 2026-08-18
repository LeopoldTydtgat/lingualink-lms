import { cache } from 'react'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCallerUser } from '@/lib/auth/callerProfile'

/**
 * The caller's own DISPLAY profile row for this request, read once and shared by
 * the admin shell and the admin dashboard.
 *
 * PER-REQUEST MEMO ONLY. React's `cache` stores its memo on the current render's
 * cache scope, which belongs to a single server request and is torn down with it.
 * The value is never shared across requests, and therefore never across users.
 * Where no cache scope exists - route handlers, server-action bodies - `cache`
 * calls straight through to the function, so those callers simply pay for their
 * own read exactly as they would without this module.
 *
 * THIS IS A DISPLAY READ, NOT AN AUTHORISATION READ. It does NOT select
 * `status`, so it can never be used as a gate: it cannot tell a current account
 * from a former or on-hold one. Authorisation goes through requireAdmin() /
 * requireStaff() / requireTeacher(), never through this. Do not add `status`
 * here to "save a query" - that would invite exactly the misuse this note
 * forbids.
 *
 * IT USES THE SERVICE-ROLE CLIENT DELIBERATELY. The admin shell already reads
 * this row that way, and the point of this module is that the layout and the
 * dashboard share ONE result, so they can no longer disagree about the viewer's
 * timezone - the field that decides which lessons count as "today" in both. A
 * second read through a different client is the disagreement.
 *
 * It returns the raw PostgREST { data, error } result unchanged: it does not
 * throw, redirect or log. Every caller keeps its own error handling, and the
 * memoised result means one caller's handling covers the shared read.
 *
 * SAME UNTESTED RESIDUAL AS callerProfile.ts: a Supabase client is constructed
 * inside a React cache scope. Nothing here reproduces or rules out the April
 * mechanism behind CLAUDE.md's "never wrap `createClient` in `cache()`" rule, so
 * this folds into the Vercel preview smoke test already owed before main - load
 * an admin page (RSC path) and call a gated API route (route-handler path), and
 * confirm neither returns `---`.
 *
 * createAdminClient() is NOT memoised; it is called inside the memo callback,
 * matching callerProfile.ts.
 *
 * Server-only - it resolves the caller from the session cookie via
 * getCallerUser(). Never import into a client component.
 */
export const getCallerDisplayProfile = cache(async () => {
  const user = await getCallerUser()
  if (!user) return { data: null, error: null }

  const adminDb = createAdminClient()
  return await adminDb
    .from('profiles')
    .select('id, full_name, role, account_types, photo_url, timezone')
    .eq('id', user.id)
    .maybeSingle()
})
