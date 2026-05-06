import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function verifyAdmin() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return null

  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('account_types, role')
    .eq('id', user.id)
    .single()

  const isAdmin =
    adminProfile?.role === 'admin' ||
    (adminProfile?.account_types ?? []).includes('school_admin')

  return isAdmin ? user : null
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await verifyAdmin()
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
      .select('id, account_types')
      .eq('id', id)
      .maybeSingle()

    if (!targetProfile) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    const accountTypes = Array.isArray(targetProfile.account_types) ? targetProfile.account_types : []
    const isTeacher = accountTypes.includes('teacher') || accountTypes.includes('teacher_exam')
    if (!isTeacher) {
      return NextResponse.json({ error: 'Target user is not a teacher.' }, { status: 400 })
    }

    const { error } = await adminClient.auth.admin.updateUserById(id, { password })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
