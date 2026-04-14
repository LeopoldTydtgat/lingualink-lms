import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Fields a student is allowed to update on their own record.
// Sensitive admin-managed fields (full_name, email, admin_notes,
// cancellation_policy, etc.) are intentionally excluded.
const ALLOWED_TEXT_FIELDS = new Set([
  'timezone',
  'language_preference',
  'learning_goals',
  'interests',
  'self_assessed_level',
])

// ── POST — photo upload (multipart/form-data) ─────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Verify the requesting user is authenticated
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const admin = createAdminClient()

    // 2. Parse multipart form data
    const formData = await req.formData()
    const photo = formData.get('photo')

    if (!(photo instanceof File) || photo.size === 0) {
      return NextResponse.json({ error: 'No photo file provided.' }, { status: 400 })
    }

    // 3. Validate type and size
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(photo.type)) {
      return NextResponse.json({ error: 'Only JPG, PNG or WebP images are allowed.' }, { status: 400 })
    }
    if (photo.size > 2 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 2MB.' }, { status: 400 })
    }

    // 4. Look up student id (needed for the storage path)
    const { data: student, error: studentError } = await admin
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (studentError || !student) {
      console.error('[POST /api/student/profile] Student lookup error:', studentError)
      return NextResponse.json({ error: 'Student record not found.' }, { status: 404 })
    }

    // 5. Upload to storage
    const ext = photo.name.split('.').pop()
    const path = `students/${student.id}/avatar.${ext}`
    const arrayBuffer = await photo.arrayBuffer()

    const { error: uploadError } = await admin.storage
      .from('avatars')
      .upload(path, arrayBuffer, { upsert: true, contentType: photo.type })

    if (uploadError) {
      console.error('[POST /api/student/profile] Storage upload error:', uploadError)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    // 6. Build public URL (with cache-busting timestamp)
    const { data: urlData } = admin.storage.from('avatars').getPublicUrl(path)
    const photoUrl = `${urlData.publicUrl}?t=${Date.now()}`

    // 7. Persist the new URL on the student record
    const { error: updateError } = await admin
      .from('students')
      .update({ photo_url: photoUrl })
      .eq('auth_user_id', user.id)

    if (updateError) {
      console.error('[POST /api/student/profile] DB update error:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, photo_url: photoUrl })
  } catch (err) {
    console.error('[POST /api/student/profile] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ── PATCH — text field updates (application/json) ─────────────────────────────

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
      if (ALLOWED_TEXT_FIELDS.has(key)) {
        patch[key] = value === '' ? null : value
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update.' }, { status: 400 })
    }

    // 3. Apply update via admin client (bypasses RLS so it always reaches the row)
    //    User identity is already verified above — they can only update their own record.
    const admin = createAdminClient()
    const { error: updateError } = await admin
      .from('students')
      .update({ ...patch, profile_completed: true })
      .eq('auth_user_id', user.id)

    if (updateError) {
      console.error('[PATCH /api/student/profile] Update error:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[PATCH /api/student/profile] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
