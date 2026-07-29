import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import TasksPageClient from './TasksPageClient'

export default async function AdminTasksPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // Same source as the admin dashboard and the class detail page: the logged-in
  // admin's own profiles.timezone, read through the cookie client, falling back to
  // UTC when unset. completed_at is stored in UTC and formatted client-side with an
  // explicit Intl timeZone, which is deterministic on server and client. A missing
  // profile row must never block the page, so this is a non-fatal read.
  const supabase = await createClient()
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', adminUser.id)
    .maybeSingle()

  const adminTz = adminProfile?.timezone ?? 'UTC'

  return <TasksPageClient adminTz={adminTz} />
}
