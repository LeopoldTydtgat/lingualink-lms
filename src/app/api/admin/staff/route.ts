import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/admin/staff
// Returns all profiles with an admin-level role, plus the current user's id
// Used by TaskForm to populate the "Assigned To" dropdown.

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const adminUser = await requireAdmin()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Admin client: profiles.role is not guaranteed readable under the anon-key
  // grants, and requireAdmin() above already gates this route server-side.
  const adminClient = createAdminClient()

  // Admin (role) plus staff accounts (account_types) populate the dropdown.
  const { data: profiles, error } = await adminClient
    .from('profiles')
    .select('id, full_name, role, account_types')
    .order('full_name')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const staff = (profiles ?? []).filter((p: any) =>
    p.role === 'admin' || p.account_types?.includes('staff')
  ).map((p: any) => ({ id: p.id, full_name: p.full_name }))

  return NextResponse.json({ staff, currentUserId: user.id })
}
