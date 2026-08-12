// src/app/(admin)/admin/announcements/[id]/edit/page.tsx
// Fetches the existing announcement plus teacher/student lists,
// then renders the shared AnnouncementForm in edit mode.

import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import AnnouncementForm from '../../AnnouncementForm'

export default async function EditAnnouncementPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // Next.js 15 — params is a Promise
  const { id } = await params

  // requireAdmin above is the gate. The data reads run on the service-role
  // client, matching (admin)/layout.tsx — the hand-rolled anon client this
  // replaced existed only for these queries and carried a no-op cookie writer.
  const adminDb = createAdminClient()

  // The dropdowns are deliberately NOT filtered to status 'current' here, unlike
  // the create page: an announcement already aimed at someone since deactivated
  // must keep showing that person as its target rather than silently losing it.
  const [announcementRes, teachersRes, studentsRes] = await Promise.all([
    // Explicit columns: exactly the fields AnnouncementForm's Announcement
    // interface reads. maybeSingle because id comes from the URL — zero rows is
    // an ordinary outcome here, not the throw .single() raised.
    adminDb
      .from('announcements')
      .select('id, title, message, target_audience, target_id, is_dismissable, is_active, start_date, end_date')
      .eq('id', id)
      .maybeSingle(),
    adminDb
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'teacher')
      .order('full_name'),
    adminDb
      .from('students')
      .select('id, full_name')
      .order('full_name'),
  ])

  if (announcementRes.error) {
    console.error('[admin/announcements/edit] announcement lookup failed:', id, announcementRes.error)
  }
  if (teachersRes.error) {
    console.error('[admin/announcements/edit] teachers lookup failed:', teachersRes.error)
  }
  if (studentsRes.error) {
    console.error('[admin/announcements/edit] students lookup failed:', studentsRes.error)
  }

  // A failed read is not a missing row: notFound() here would tell the admin the
  // announcement had been deleted, and empty dropdowns would hide every valid
  // target. Both are wrong answers to "the query broke".
  if (announcementRes.error || teachersRes.error || studentsRes.error) {
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

  // Confirmed-empty read — this id really does not exist.
  if (!announcementRes.data) notFound()

  return (
    <AnnouncementForm
      announcement={announcementRes.data}
      teachers={teachersRes.data ?? []}
      students={studentsRes.data ?? []}
    />
  )
}
