// src/app/api/announcements/dismiss/route.ts
// Records that a user has dismissed an announcement.
// Called by AnnouncementBanner when the user clicks the X button.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: NextRequest) {
  try {
    // Only announcementId is read from the body — userType/userId are derived from
    // the verified session, never from the client.
    const { announcementId } = await req.json()
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!announcementId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // A profiles row keyed by the auth uid means this is a teacher/admin; students
    // have no profiles row (their auth uid lives on students.auth_user_id). Read via
    // the service-role client so a restrictive profiles RLS policy cannot silently
    // misclassify a teacher as a student — it reads one column of one row already
    // keyed by the caller's own verified auth uid.
    const admin = createAdminClient()
    const { data: profileRow, error: profileError } = await admin
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      console.error('[announcements/dismiss] profiles lookup failed:', profileError)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    const userType = profileRow ? 'teacher' : 'student'

    // Insert dismissal using verified session user — never trust userId from request body
    // Ignore if already exists (user dismissed before)
    const { error } = await supabase
      .from('announcement_dismissals')
      .insert({
        announcement_id: announcementId,
        user_id: user.id,
        user_type: userType,
        dismissed_at: new Date().toISOString(),
      })

    // Code 23505 = unique violation — already dismissed, that's fine
    if (error && error.code !== '23505') {
      console.error('Dismissal insert error:', error)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Dismiss route error:', e)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
