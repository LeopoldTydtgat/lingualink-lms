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
    // The participant triple is NOT presence-checked here: on the user path it is
    // ignored entirely (derived server-side); on the staff path it is checked and
    // source-table-verified below. So the only universal requirement is a payload.
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0
    if (!content?.trim() && !hasAttachments) {
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

    // Fail safe on the role lookup: a query error returns 500 rather than silently
    // demoting the sender to non-staff. Zero rows is NOT an error here (students have
    // no profiles row), so .maybeSingle() — a missing profile is a normal user send.
    const admin = createAdminClient()
    const { data: senderProfile, error: senderProfileError } = await admin
      .from('profiles')
      .select('role, account_types, status')
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
    // support, not support answering. Service identity applies only when the caller
    // is staff AND is addressing a DIFFERENT participant's thread (a non-empty
    // participantAuthId that is not their own uid). A staff send with no/own
    // participantAuthId falls through to the user path and is fully server-derived.
    const isActingAsSupport = Boolean(isStaffOrAdmin) &&
      typeof participantAuthId === 'string' &&
      participantAuthId.length > 0 &&
      participantAuthId !== user.id

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

    // ── Resolve the participant triple written to the row. ──────────────────────
    // NEW-audit: the row's identity (participant_id / participant_type /
    // participant_auth_id) is NEVER trusted from the client on the user path, and is
    // source-table-verified on the staff path. This prevents a non-staff sender from
    // mislabelling their own thread as another teacher/student (identity spoofing in
    // the admin inbox) or hijacking another participant's conversation.
    let rowParticipantId: string
    let rowParticipantType: 'teacher' | 'student'
    let rowParticipantAuthId: string

    if (isActingAsSupport) {
      // STAFF PATH — the body triple is used, but only after it is verified against
      // the source tables. The participant fields are required here (they identify
      // WHOSE thread the reply lands in), so presence-check them now. participantAuthId
      // is already guaranteed non-empty by isActingAsSupport, so only id/type remain.
      if (!participantId || !participantType) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      if (participantType !== 'teacher' && participantType !== 'student') {
        return NextResponse.json({ error: 'Invalid participant' }, { status: 400 })
      }

      if (participantType === 'teacher') {
        // Teachers live in profiles, where the PK IS the auth uuid — so a valid
        // teacher thread requires participantId === participantAuthId AND a matching
        // profiles row. Fail closed on a query error (do not fall through to insert).
        if (participantId !== participantAuthId) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        const { data: teacherRow, error: teacherErr } = await admin
          .from('profiles')
          .select('id')
          .eq('id', participantId)
          .maybeSingle()
        if (teacherErr) {
          console.error('[support/send] participant teacher lookup error:', teacherErr)
          return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
        }
        if (!teacherRow) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      } else {
        // Students use the table PK (students.id) as participant_id and the auth uuid
        // (students.auth_user_id) as participant_auth_id — require BOTH to match the
        // same row so the pair cannot be forged apart. Fail closed on a query error.
        const { data: studentRow, error: studentErr } = await admin
          .from('students')
          .select('id')
          .eq('id', participantId)
          .eq('auth_user_id', participantAuthId)
          .maybeSingle()
        if (studentErr) {
          console.error('[support/send] participant student lookup error:', studentErr)
          return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
        }
        if (!studentRow) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      }

      rowParticipantId = participantId
      rowParticipantType = participantType
      rowParticipantAuthId = participantAuthId
    } else {
      // USER PATH — a plain user (teacher or student) sending into their OWN thread.
      // The body's participant fields are ignored entirely; the triple is derived
      // from the authenticated user.id. participant_auth_id is always the auth uuid.
      //
      // A profiles row ALONE is not proof of teacher identity: an auth uid can hold a
      // former teacher profile AND a current student row. Classify as teacher only
      // when the profiles row is an admin (school owner) or is itself current;
      // otherwise fall through to the students lookup so a current student is stored
      // as a student, not mislabelled 'teacher' in the admin inbox. (The isSenderCurrent
      // gate above already 403s any non-current row, so this is defence-in-depth — it
      // keeps classification correct independent of that gate's ordering.)
      if (senderProfile && (senderProfile.role === 'admin' || senderProfile.status === 'current')) {
        // profiles.id IS the auth uuid for teachers/admins.
        rowParticipantId = user.id
        rowParticipantType = 'teacher'
        rowParticipantAuthId = user.id
      } else {
        // No usable teacher profile → student. Look up the students PK by auth_user_id.
        // Fail closed on a query error (500); a missing student row is a forbidden send.
        const { data: studentRow, error: studentErr } = await admin
          .from('students')
          .select('id')
          .eq('auth_user_id', user.id)
          .maybeSingle()
        if (studentErr) {
          console.error('[support/send] sender student lookup error:', studentErr)
          return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
        }
        if (!studentRow) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        rowParticipantId = studentRow.id
        rowParticipantType = 'student'
        rowParticipantAuthId = user.id
      }
    }

    const safeContent = sanitizeHtml(content ?? '')

    const { data: newMessage, error } = await admin
      .from('support_messages')
      .insert({
        participant_id: rowParticipantId,
        participant_type: rowParticipantType,
        participant_auth_id: rowParticipantAuthId,
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
