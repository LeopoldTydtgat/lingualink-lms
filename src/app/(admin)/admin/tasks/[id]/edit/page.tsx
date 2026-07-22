import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import EditTaskPageClient from './EditTaskPageClient'

export default async function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <EditTaskPageClient params={params} />
}
