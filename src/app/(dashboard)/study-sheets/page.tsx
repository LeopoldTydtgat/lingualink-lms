import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StudySheetsClient from './StudySheetsClient'

export default async function StudySheetsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  const { data: studySheets } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  return (
    <StudySheetsClient
      studySheets={studySheets ?? []}
      isAdmin={profile?.role === 'admin'}
    />
  )
}