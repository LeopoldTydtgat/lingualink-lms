// src/app/(admin)/admin/announcements/[id]/edit/page.tsx
// Fetches the existing announcement plus teacher/student lists,
// then renders the shared AnnouncementForm in edit mode.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import AnnouncementForm from '../../AnnouncementForm'

export default async function EditAnnouncementPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Next.js 15 — params is a Promise
  const { id } = await params

  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  const [{ data: announcement }, { data: teachers }, { data: students }] =
    await Promise.all([
      supabase
        .from('announcements')
        .select('*')
        .eq('id', id)
        .single(),
      supabase
        .from('profiles')
        .select('id, full_name')
        .eq('role', 'teacher')
        .order('full_name'),
      supabase
        .from('students')
        .select('id, full_name')
        .order('full_name'),
    ])

  if (!announcement) notFound()

  return (
    <AnnouncementForm
      announcement={announcement}
      teachers={teachers ?? []}
      students={students ?? []}
    />
  )
}
