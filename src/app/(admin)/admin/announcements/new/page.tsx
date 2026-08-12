// src/app/(admin)/admin/announcements/new/page.tsx
// Fetches teacher and student lists for the specific-target dropdowns,
// then renders the shared AnnouncementForm in create mode.

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import AnnouncementForm from '../AnnouncementForm'

export default async function NewAnnouncementPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // requireAdmin above is the gate. The dropdown reads run on the service-role
  // client, matching (admin)/layout.tsx — the hand-rolled anon client this
  // replaced existed only for these queries and carried a no-op cookie writer.
  const adminDb = createAdminClient()

  // status 'current' is the canonical active-account gate on both tables, so a
  // former or on-hold person is not offered as the target of a new banner they
  // can no longer sign in to see.
  const [teachersRes, studentsRes] = await Promise.all([
    adminDb
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'teacher')
      .eq('status', 'current')
      .order('full_name'),
    adminDb
      .from('students')
      .select('id, full_name')
      .eq('status', 'current')
      .order('full_name'),
  ])

  if (teachersRes.error) {
    console.error('[admin/announcements/new] teachers lookup failed:', teachersRes.error)
  }
  if (studentsRes.error) {
    console.error('[admin/announcements/new] students lookup failed:', studentsRes.error)
  }

  // An empty dropdown looks like "nobody to target" and would push the admin
  // into saving a broadcast they did not intend — surface the failure instead.
  if (teachersRes.error || studentsRes.error) {
    return (
      <div className="p-6">
        <div
          role="alert"
          className="rounded-lg px-4 py-3 text-sm"
          style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}
        >
          Failed to load the announcement form.
        </div>
      </div>
    )
  }

  return (
    <AnnouncementForm
      teachers={teachersRes.data ?? []}
      students={studentsRes.data ?? []}
    />
  )
}
