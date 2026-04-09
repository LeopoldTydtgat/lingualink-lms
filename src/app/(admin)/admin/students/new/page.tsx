import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import CreateStudentClient from './CreateStudentClient'

export default async function NewStudentPage() {
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

  // Fetch companies for the company dropdown
  const { data: companies } = await supabase
    .from('companies')
    .select('id, name')
    .eq('status', 'active')
    .order('name', { ascending: true })

  // Fetch teachers for academic advisor and assigned teacher dropdowns
  const { data: teachers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('role', ['teacher', 'admin'])
    .eq('is_active', true)
    .order('full_name', { ascending: true })

  return (
    <CreateStudentClient
      companies={companies ?? []}
      teachers={teachers ?? []}
    />
  )
}
