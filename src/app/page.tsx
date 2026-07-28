import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getPortal } from '@/lib/host'
import { createClient } from '@/lib/supabase/server'

export default async function RootPage() {
  const headersList = await headers()
  const host = headersList.get('host')
  const portal = getPortal(host)

  // Production subdomains resolve to a portal directly from the host.
  if (portal === 'student') redirect('/student/my-classes')
  if (portal === 'teacher') redirect('/upcoming-classes')

  // Unknown host (localhost, vercel preview, apex): the host can't tell us
  // the portal, so check the session. A logged-in user must land on their
  // dashboard, NOT the login screen. Only fall through to /login when there
  // is genuinely no session. (This page is behind proxy.ts, which has
  // already run the active-account/status check for a logged-in user.)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Distinguish teacher/admin (has a profiles row, keyed by auth id) from a
  // student (no profiles row). Own-row read is permitted by RLS, so the
  // cookie client suffices — no admin client needed.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  // A lookup error must throw to the retryable root error boundary, never
  // redirect: an errored null previously read as "no profiles row" and
  // misrouted a teacher/admin to the student portal, which could loop while
  // the proxy's 60s status cache suppressed the role gate.
  if (profileError) {
    console.error('[root] profiles lookup failed:', profileError)
    throw new Error('Failed to resolve portal')
  }

  if (profile) redirect('/upcoming-classes')
  redirect('/student/my-classes')
}
