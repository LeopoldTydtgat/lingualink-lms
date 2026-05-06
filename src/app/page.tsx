import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getPortal } from '@/lib/host'

export default async function RootPage() {
  const headersList = await headers()
  const host = headersList.get('host')
  const portal = getPortal(host)
  if (portal === 'student') redirect('/student/my-classes')
  if (portal === 'admin') redirect('/admin')
  if (portal === 'teacher') redirect('/upcoming-classes')
  // Non-production / unknown host (localhost, vercel preview, apex)
  redirect('/login')
}
