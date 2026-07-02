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

  const { data: isAdminResult } = await supabase.rpc('is_admin')

  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, content, attachments')
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
      isAdmin={isAdminResult === true}
    />
  )
}