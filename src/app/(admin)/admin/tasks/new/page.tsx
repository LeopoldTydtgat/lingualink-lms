import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import NewTaskPageClient from './NewTaskPageClient'

export default async function NewTaskPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <NewTaskPageClient />
}
