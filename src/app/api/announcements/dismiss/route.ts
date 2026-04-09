// src/app/api/announcements/dismiss/route.ts
// Records that a user has dismissed an announcement.
// Called by AnnouncementBanner when the user clicks the X button.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  try {
    const { announcementId, userType, userId } = await req.json()

    if (!announcementId || !userType || !userId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = await createClient()

    // Insert dismissal — ignore if already exists (user dismissed before)
    const { error } = await supabase
      .from('announcement_dismissals')
      .insert({
        announcement_id: announcementId,
        user_id: userId,
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
