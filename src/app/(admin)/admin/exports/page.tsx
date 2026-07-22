import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import ExportsPageClient from './ExportsPageClient'

export default async function AdminExportsPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <ExportsPageClient />
}
