// src/app/(admin)/admin/announcements/page.tsx
// Fetches all announcements and passes them to the client component.

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import AnnouncementsClient from './AnnouncementsClient'

export default async function AnnouncementsPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // requireAdmin above is the gate. The data read runs on the service-role
  // client, matching (admin)/layout.tsx — the hand-rolled anon client this
  // replaced existed only for this query and carried a no-op cookie writer.
  const adminDb = createAdminClient()

  // Explicit columns: exactly the fields AnnouncementsClient's Announcement
  // interface consumes, plus created_at, which drives the ordering.
  const { data: announcements, error } = await adminDb
    .from('announcements')
    .select('id, title, message, target_audience, target_id, is_dismissable, is_active, start_date, end_date, created_at')
    .order('created_at', { ascending: false })

  // A failed read must never render as the client's "No announcements yet"
  // empty state: that reads as a confident zero and invites the admin to
  // recreate a banner that already exists.
  if (error) {
    console.error('[admin/announcements] announcements lookup failed:', error)
    return (
      <div className="p-6">
        <div
          role="alert"
          className="rounded-lg px-4 py-3 text-sm"
          style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}
        >
          Failed to load announcements.
        </div>
      </div>
    )
  }

  return <AnnouncementsClient announcements={announcements ?? []} />
}
