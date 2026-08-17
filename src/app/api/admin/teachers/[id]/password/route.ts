import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { isTeacherProfile } from '@/lib/auth/isTeacherProfile'

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

    // Confirm `id` belongs to a teacher profile before resetting the auth
    // password. Without this, an admin could pass any user id (e.g. another
    // admin's) and the route would reset that user's password instead.
    const { data: targetProfile } = await adminClient
      .from('profiles')
      .select('id, role, account_types')
      .eq('id', id)
      .maybeSingle()

    if (!targetProfile) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    // THE canonical teacher rule (src/lib/auth/isTeacherProfile.ts) — the same
    // one the Teachers list page, the list API and the teacher PATCH route
    // apply: account_types overlaps ['teacher','teacher_exam'] OR role
    // 'admin'. The local account_types-only copy this replaced left out the
    // role 'admin' arm, so an admin profile the Teachers section lists and
    // manages could not have its password set from that same screen.
    if (!isTeacherProfile(targetProfile)) {
      return NextResponse.json({ error: 'Target user is not a teacher.' }, { status: 400 })
    }

    const { error } = await adminClient.auth.admin.updateUserById(id, { password })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Fatal here, unlike the archive path: nothing else evicts the old session -
    // there is no ban and no status gate - so a session that survives this reset
    // leaves the previous holder signed in with full access after the admin has
    // changed the password, which is the exact attack this reset exists to stop.
    // Retrying is safe: the password update is idempotent and the revoke re-runs.
    const { error: revokeError } = await adminClient.rpc('revoke_user_sessions', { p_user_id: id })
    if (revokeError) {
      console.error('[password reset teacher] session revocation failed:', revokeError)
      return NextResponse.json(
        { error: 'The password was updated, but existing sessions could not be signed out. Please retry to force sign-out everywhere.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
