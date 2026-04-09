import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import CompaniesListClient from './CompaniesListClient'

export default async function CompaniesPage() {
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

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, type, contact_name, contact_email, status, cancellation_policy')
    .order('name')

  // Count active students per company
  const { data: studentCounts } = await supabase
    .from('students')
    .select('company_id')
    .not('company_id', 'is', null)
    .eq('status', 'current')

  const countMap: Record<string, number> = {}
  for (const s of studentCounts ?? []) {
    if (s.company_id) {
      countMap[s.company_id] = (countMap[s.company_id] ?? 0) + 1
    }
  }

  const rows = (companies ?? []).map((c) => ({
    ...c,
    student_count: countMap[c.id] ?? 0,
  }))

  return <CompaniesListClient companies={rows} />
}
