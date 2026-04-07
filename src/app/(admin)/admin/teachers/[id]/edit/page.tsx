import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import EditTeacherClient from './EditTeacherClient'

export default async function EditTeacherPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string }>
}) {
  const { id } = await params
  const { section } = await searchParams
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

  const { data: teacher, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !teacher) notFound()

  // section=public means open straight to Profile & Admin Info tab
  const initialSection = section === 'public' ? 'B' : 'A'

  return <EditTeacherClient teacher={teacher} initialSection={initialSection} />
}