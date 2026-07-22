import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import CreateTeacherClient from './CreateTeacherClient'

export default async function NewTeacherPage() {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  return <CreateTeacherClient />
}