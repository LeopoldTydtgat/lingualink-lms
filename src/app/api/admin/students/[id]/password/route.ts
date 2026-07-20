import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin()
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const { password } = await req.json()

    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    const adminClient = createAdminClient()

    const { data: student, error: fetchError } = await adminClient
      .from('students')
      .select('id, auth_user_id')
      .eq('id', id)
      .maybeSingle()

    if (fetchError || !student) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    if (!student.auth_user_id) {
      return NextResponse.json({ error: 'Student has no linked auth user.' }, { status: 404 })
    }

    const { error } = await adminClient.auth.admin.updateUserById(student.auth_user_id, { password })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    try {
      await adminClient.auth.admin.signOut(student.auth_user_id, 'global')
    } catch (signOutError) {
      console.error('[password reset student] signOut failed:', signOutError)
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
