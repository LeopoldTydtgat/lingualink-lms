import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StudySheetsClient from './StudySheetsClient'

export default async function StudySheetsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .maybeSingle()

  // House rule: a null profile is NOT an unauthenticated user - never redirect.
  // Render a plain fallback instead.
  if (!profile) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <p className="text-sm" style={{ color: '#4b5563' }}>
          Your profile could not be loaded. Please refresh the page or contact support.
        </p>
      </div>
    )
  }

  // NEW373: mirror requireAdmin.ts exactly - role = 'admin' OR account_types
  // containing 'school_admin'. No variant.
  const isAdmin =
    profile.role === 'admin' ||
    (Array.isArray(profile.account_types) && profile.account_types.includes('school_admin'))

  const { data: studySheets } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, is_active, created_at, audience, owner_id')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  return (
    <StudySheetsClient
      studySheets={studySheets ?? []}
      isAdmin={isAdmin}
      currentUserId={user.id}
    />
  )
}
