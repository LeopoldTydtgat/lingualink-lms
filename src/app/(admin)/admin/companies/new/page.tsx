import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import CreateCompanyClient from './CreateCompanyClient'

export default async function NewCompanyPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <CreateCompanyClient />
}
