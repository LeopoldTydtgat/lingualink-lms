import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import EditCompanyClient from './EditCompanyClient'

export default async function EditCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createAdminClient()

  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !company) notFound()

  return <EditCompanyClient company={company} />
}
