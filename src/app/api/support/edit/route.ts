import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { messageId, content } = await request.json()

    if (!messageId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Security: authenticated has no UPDATE grant on support_messages.content, so the
    // edit runs through the admin client after an explicit ownership check. A non-admin
    // may edit only their own messages (participant_auth_id match, sender_role 'user');
    // an admin may edit only admin replies. Fail closed on any lookup error.
    const admin = createAdminClient()
    const { data: senderProfile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    const isAdmin = senderProfile?.role === 'admin'

    const { data: target, error: fetchError } = await admin
      .from('support_messages')
      .select('id, participant_auth_id, sender_role, attachments, created_at')
      .eq('id', messageId)
      .maybeSingle()

    if (fetchError) {
      console.error('[support/edit] fetch error:', fetchError)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
    if (!target) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const canEdit = isAdmin
      ? target.sender_role === 'admin'
      : target.participant_auth_id === user.id && target.sender_role === 'user'
    if (!canEdit) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // 15-minute edit window (applies to everyone, admin included), checked against
    // the DB row's created_at - never a client-supplied timestamp. The client hides
    // the Edit button past the window, but a stale open thread can still submit -
    // this is the authoritative check.
    if (!isWithinEditWindow(target.created_at)) {
      return NextResponse.json({ error: EDIT_WINDOW_ERROR }, { status: 403 })
    }

    // Content may be empty only when the message carries attachments (attachment-only
    // message, mirroring api/support/send). Attachments are never modified by an edit.
    const hasAttachments = Array.isArray(target.attachments) && target.attachments.length > 0
    if (!content?.trim() && !hasAttachments) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const safeContent = sanitizeHtml(content ?? '')

    const { data: updated, error } = await admin
      .from('support_messages')
      .update({ content: safeContent, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .select('id, sender_role, content, attachments, created_at, read_at, edited_at')
      .single()

    if (error) {
      console.error('[support/edit] update error:', error)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: updated })
  } catch (err) {
    console.error('[support/edit]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
