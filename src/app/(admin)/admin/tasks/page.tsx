import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import TasksPageClient from './TasksPageClient'

export default async function AdminTasksPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <TasksPageClient />
}
