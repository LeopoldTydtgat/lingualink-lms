import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClassesListClient from './ClassesListClient'

export default async function AdminClassesPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types, full_name')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.account_types?.includes('school_admin') ||
    profile?.account_types?.includes('staff')

  if (!isAdmin) redirect('/dashboard')

  // Fetch teacher list for the filter dropdown
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .contains('account_types', ['teacher'])
    .eq('is_active', true)
    .order('full_name')

  return (
    <ClassesListClient
      teachers={teachers ?? []}
    />
  )
}
