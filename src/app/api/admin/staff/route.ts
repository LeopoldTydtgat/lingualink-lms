import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/admin/staff
// Returns all profiles with an admin-level role, plus the current user's id
// Used by TaskForm to populate the "Assigned To" dropdown.

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: currentProfile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const allowedRoles = ['school_admin', 'staff', 'hr_admin']
  const hasAccess = currentProfile?.account_types?.some((r: string) => allowedRoles.includes(r))
  if (!hasAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Return all profiles that have at least one admin-level role
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, full_name, account_types')
    .order('full_name')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const staff = (profiles ?? []).filter((p: any) =>
    p.account_types?.some((r: string) => allowedRoles.includes(r))
  ).map((p: any) => ({ id: p.id, full_name: p.full_name }))

  return NextResponse.json({ staff, currentUserId: user.id })
}
