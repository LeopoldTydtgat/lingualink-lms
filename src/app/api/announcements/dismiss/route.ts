// src/app/api/announcements/dismiss/route.ts
// Records that a user has dismissed an announcement.
// Called by AnnouncementBanner when the user clicks the X button.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  try {
    const { announcementId, userType } = await req.json()
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!announcementId || !userType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Dismiss route error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
