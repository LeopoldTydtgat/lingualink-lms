import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StudySheetFormClient from './StudySheetFormClient'

export default async function NewStudySheetPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  // Only admins can create study sheets
  if (profile?.role !== 'admin') redirect('/study-sheets')

  return <StudySheetFormClient mode="create" />
}