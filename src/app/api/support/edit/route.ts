import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'
import { ACCOUNT_INACTIVE_ERROR, isSenderCurrent } from '@/lib/access/accountStatus'

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
    // an admin may edit only admin replies they authored themselves (NEW336:
    // sender_auth_id match) or legacy admin rows with no author recorded
    // (sender_auth_id NULL — deliberately editable by any admin, no backfill).
    // Fail closed on any lookup error. The role lookup fails safe too: a query
    // error returns 500 rather than silently demoting the sender to non-admin
    // (zero rows is normal — students have no profiles row).
    const admin = createAdminClient()
    const { data: senderProfile, error: senderProfileError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (senderProfileError) {
      console.error('[support/edit] sender profile fetch error:', senderProfileError)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    const isAdmin = senderProfile?.role === 'admin'

    const { data: target, error: fetchError } = await admin
      .from('support_messages')
      .select('id, participant_auth_id, sender_role, sender_auth_id, attachments, created_at')
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
      ? target.sender_role === 'admin' &&
        (target.sender_auth_id === null || target.sender_auth_id === user.id)
      : target.participant_auth_id === user.id && target.sender_role === 'user'
    if (!canEdit) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // NEW347: the SENDER's own account must still be current, mirroring the send route.
    // Ownership above only proves the row is theirs — a former student or former teacher
    // holding a live session (past proxy.ts's 60s cookie cache) must not be able to edit
    // content into a thread either. Keyed on user.id (the AUTH uuid) via isSenderCurrent,
    // NOT isCounterpartCurrent (table PK). Fail closed on a missing row or query error.
    if (!(await isSenderCurrent(admin, user.id))) {
      return NextResponse.json({ error: ACCOUNT_INACTIVE_ERROR }, { status: 403 })
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

    // Defence-in-depth: re-bind the ownership conditions on the UPDATE itself
    // (mirrors the messages editMessage actions' .eq('sender_id', ...)), so the
    // statement can never touch a row the canEdit check above didn't cover.
    // If the filters match nothing, .single() errors and the edit fails closed.
    let updateQuery = admin
      .from('support_messages')
      .update({ content: safeContent, edited_at: new Date().toISOString() })
      .eq('id', messageId)

    updateQuery = isAdmin
      ? updateQuery
          .eq('sender_role', 'admin')
          .or(`sender_auth_id.is.null,sender_auth_id.eq.${user.id}`)
      : updateQuery
          .eq('participant_auth_id', user.id)
          .eq('sender_role', 'user')

    const { data: updated, error } = await updateQuery
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
