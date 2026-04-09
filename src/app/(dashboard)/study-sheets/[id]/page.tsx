import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import StudySheetDetailClient from './StudySheetDetailClient'

export default async function StudySheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('*')
    .eq('id', id)
    .single()

  if (!sheet) notFound()

  const { data: exercises } = await supabase
    .from('exercises')
    .select('*')
    .eq('study_sheet_id', id)
    .order('created_at', { ascending: true })

  return (
    <StudySheetDetailClient
      sheet={sheet}
      exercises={exercises ?? []}
      isAdmin={profile?.role === 'admin'}
    />
  )
}