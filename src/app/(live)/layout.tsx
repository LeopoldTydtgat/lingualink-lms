// src/app/(live)/layout.tsx
// Chrome-free layout for the live-annotate route group. The teacher screen-shares
// this route during a live class, so it must render NONE of the (dashboard) shell —
// no LeftNav / TopHeader / RightPanel (RightPanel exposes the teacher's earnings and
// the next student's name). Those mount only in (dashboard)/layout.tsx; as a sibling
// route group, (live) never inherits them. Do NOT add any chrome component here.
//
// Auth gate mirrors (dashboard)/layout.tsx exactly: getUser + redirect on no user,
// THEN a profiles-row existence check as a defense-in-depth role backstop. The other
// fields the (dashboard) fetch returns (full_name, email, photo_url, role, timezone)
// are dropped here — none are rendered in this chrome-free layout — but the
// `if (!profile) redirect('/login')` check itself is KEPT, so a logged-in non-teacher
// (no profiles row, e.g. a student) is bounced. This keeps (live) never weaker than
// (dashboard). src/proxy.ts remains the primary role gate, but it sits behind a 60s
// cross-subdomain role cache; this in-layout backstop closes that window for every
// route ever added under (live).
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export default async function LiveLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Role backstop — semantic mirror of (dashboard)/layout.tsx. Same admin
  // (service-role) client, same `profiles` table, same `.eq('id', user.id)` filter,
  // same `if (!profile) redirect('/login')`. Only the minimal `id` column is selected
  // (pure existence test — nothing from the row is rendered or passed to children).
  // `.maybeSingle()` (not `.single()`) because zero rows is the normal case for any
  // non-teacher auth user; the bounce is identical to (dashboard) — both leave
  // `profile` null on zero rows, and `id` is the PK so there is never more than one.
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) redirect('/login')

  return <div className="min-h-screen" style={{ backgroundColor: '#f9fafb' }}>{children}</div>
}
