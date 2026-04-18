import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Fields a teacher is allowed to update on their own profile.
// Sensitive admin-managed fields (hourly_rate, admin_notes, cancellation_policy, etc.)
// are intentionally excluded from this list.
const ALLOWED_FIELDS = new Set([
  'full_name',
  'timezone',
  'bio',
  'teaching_languages',
  'speaking_languages',
  'photo_url',
])

export async function PATCH(req: NextRequest) {
  try {
    // 1. Verify the requesting user is authenticated
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // 2. Parse body and whitelist to allowed fields only
    const body = await req.json()
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key)) {
        patch[key] = value
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update.' }, { status: 400 })
    }

    // 3. Apply update via admin client (bypasses RLS so it always reaches the row)
    //    User identity is already verified above — they can only update their own profile.
    const admin = createAdminClient()
    const { error: updateError } = await admin
      .from('profiles')
      .update({ ...patch, profile_completed: true })
      .eq('id', user.id)

    if (updateError) {
      console.error('Profile update error:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH /api/profile error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
