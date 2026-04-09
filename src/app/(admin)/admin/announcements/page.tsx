// src/app/(admin)/admin/announcements/page.tsx
// Fetches all announcements and passes them to the client component.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import AnnouncementsClient from './AnnouncementsClient'

export default async function AnnouncementsPage() {
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

  const { data: announcements } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })

  return <AnnouncementsClient announcements={announcements ?? []} />
}
