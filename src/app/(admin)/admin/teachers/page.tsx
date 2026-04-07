import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import TeachersListClient from './TeachersListClient'

export default async function TeachersPage() {
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

  // Fetch all teachers with their class counts
  const { data: teachers, error } = await supabase
    .from('profiles')
    .select(`
      id,
      full_name,
      email,
      photo_url,
      status,
      account_types,
      hourly_rate,
      role,
      lessons (count)
    `)
    .in('role', ['teacher', 'admin'])
    .order('full_name', { ascending: true })

  if (error) {
    console.error('Error fetching teachers:', error)
  }

  // Flatten the nested lessons count that Supabase returns as an array
  const teachersWithCount = (teachers || []).map((t) => ({
    ...t,
    lesson_count: Array.isArray(t.lessons) ? t.lessons[0]?.count ?? 0 : 0,
  }))

  return <TeachersListClient teachers={teachersWithCount} />
}