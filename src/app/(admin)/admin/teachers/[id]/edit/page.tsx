import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
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
  const supabase = createAdminClient()

  // Fetch teacher profile — includes sensitive admin-only fields
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
