// src/app/(admin)/admin/announcements/new/page.tsx
// Fetches teacher and student lists for the specific-target dropdowns,
// then renders the shared AnnouncementForm in create mode.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import AnnouncementForm from '../AnnouncementForm'

export default async function NewAnnouncementPage() {
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

  const [{ data: teachers }, { data: students }] = await Promise.all([
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

  return (
    <AnnouncementForm
      teachers={teachers ?? []}
      students={students ?? []}
    />
  )
}
