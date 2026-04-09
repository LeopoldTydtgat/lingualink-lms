import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Admin role check
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { invoiceId } = await req.json()
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId required' }, { status: 400 })

  const { error } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
