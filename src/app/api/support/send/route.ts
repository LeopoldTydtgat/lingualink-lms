import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { validateAttachments } from '@/lib/messages/validateAttachments'
import { ACCOUNT_INACTIVE_ERROR, isSenderCurrent } from '@/lib/access/accountStatus'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { participantId, participantType, participantAuthId, content, attachments } = await request.json()

    // Content may be empty when a non-empty attachments array is present
    // (attachment-only message). The attachments array is fully validated below.
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0
    if (!participantId || !participantType || !participantAuthId || (!content?.trim() && !hasAttachments)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Validate attachments (optional) via the shared helper. Strips any extra keys —
    // only { url, filename, size } is persisted — and pins each URL to the Supabase
    // project host (phishing guard), mirroring the main-messages attachment contract.
    const validation = validateAttachments(attachments)
    if (!validation.ok) {
      return NextResponse.json({ error: 'Invalid attachments' }, { status: 400 })
    }
    const safeAttachments = validation.attachments

    // Security: non-staff users can only send for themselves. Fail safe on the
    // role lookup: a query error returns 500 rather than silently demoting the
    // sender to non-staff. Zero rows is NOT an error here (students have no
    // profiles row), so .maybeSingle() — a missing profile is a normal user send.
    const admin = createAdminClient()
    const { data: senderProfile, error: senderProfileError } = await admin
      .from('profiles')
      .select('role, full_name, email, account_types, status')
      .eq('id', user.id)
      .maybeSingle()

    if (senderProfileError) {
      console.error('[support/send] sender profile fetch error:', senderProfileError)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }

    // ROLE-5a: support answering is staff-or-admin. role='admin' is the school
    // owner; staff = account_types contains 'staff' AND status='current'.
    const isStaffOrAdmin = senderProfile?.role === 'admin' ||
      (senderProfile?.account_types?.includes('staff') && senderProfile?.status === 'current')

    // A staff/admin member sending into their OWN thread is a user asking for
    // support, not support answering. Service identity applies only to replies
    // in other participants' threads.
    const isActingAsSupport = isStaffOrAdmin && user.id !== participantAuthId

    if (!isStaffOrAdmin && user.id !== participantAuthId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // NEW347: the SENDER's own account must still be current. proxy.ts blocks a
    // deactivated account at the portal, but only within its 60s cookie cache — this
    // route was otherwise unguarded, so a former student or former teacher holding a
    // live session could still open or continue a support thread. Applies to every
    // sender, admin included. Keyed on user.id (the AUTH uuid) via isSenderCurrent,
    // NOT isCounterpartCurrent (which takes the table PK and would deny every
    // student). Never gate on the client-supplied participantId/participantType.
    // Fail closed: the helper denies on a missing row or a query error.
    if (!(await isSenderCurrent(admin, user.id))) {
      return NextResponse.json({ error: ACCOUNT_INACTIVE_ERROR }, { status: 403 })
    }

    const safeContent = sanitizeHtml(content ?? '')

    const { data: newMessage, error } = await admin
      .from('support_messages')
      .insert({
        participant_id: participantId,
        participant_type: participantType,
        participant_auth_id: participantAuthId,
        // ROLE-5a: one service identity ("LinguaLink Support") — staff replies
        // carry sender_role 'admin' too; there is no 'staff' sender_role.
        sender_role: isActingAsSupport ? 'admin' : 'user',
        // NEW336: attribute admin/staff replies to the author (auth uid).
        // User rows stay NULL — participant_auth_id already identifies the sender.
        sender_auth_id: isActingAsSupport ? user.id : null,
        content: safeContent,
        attachments: safeAttachments,
      })
      .select('id, sender_role, content, attachments, created_at')
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
