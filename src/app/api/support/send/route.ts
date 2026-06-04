import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeHtml } from '@/lib/sanitize-server'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { participantId, participantType, participantAuthId, content } = await request.json()

    if (!participantId || !participantType || !participantAuthId || !content?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Security: non-admin users can only send for themselves
    const admin = createAdminClient()
    const { data: senderProfile } = await admin
      .from('profiles')
      .select('role, full_name, email')
      .eq('id', user.id)
      .single()

    const isAdmin = senderProfile?.role === 'admin'

    if (!isAdmin && user.id !== participantAuthId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const safeContent = sanitizeHtml(content)

    const { data: newMessage, error } = await admin
      .from('support_messages')
      .insert({
        participant_id: participantId,
        participant_type: participantType,
        participant_auth_id: participantAuthId,
        sender_role: isAdmin ? 'admin' : 'user',
        content: safeContent,
      })
      .select('id, sender_role, content, created_at')
      .single()

    if (error) {
      console.error('[support/send] insert error:', error)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: newMessage })
  } catch (err) {
    console.error('[support/send]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
