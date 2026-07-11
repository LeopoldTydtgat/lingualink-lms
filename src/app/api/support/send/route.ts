import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeHtml } from '@/lib/sanitize-server'

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

    // Validate attachments (optional). Strip any extra keys — only { url, filename, size }
    // are persisted, mirroring the main-messages attachment contract.
    let safeAttachments: Array<{ url: string; filename: string; size: number }> = []
    if (attachments !== undefined && attachments !== null) {
      if (!Array.isArray(attachments) || attachments.length > 5) {
        return NextResponse.json({ error: 'Invalid attachments' }, { status: 400 })
      }
      // Pin attachment URLs to the Supabase project host so a caller can't plant a
      // link to an arbitrary domain (phishing) in the persisted thread.
      const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host
      for (const att of attachments) {
        if (
          !att || typeof att !== 'object' ||
          typeof att.url !== 'string' || !att.url.startsWith('https://') ||
          typeof att.filename !== 'string' || att.filename.length === 0 || att.filename.length > 255 ||
          typeof att.size !== 'number' || !Number.isFinite(att.size) || att.size < 0 || att.size > 10485760
        ) {
          return NextResponse.json({ error: 'Invalid attachments' }, { status: 400 })
        }
        // Wrap the parse so a malformed URL also 400s rather than throwing.
        let attHost: string
        try {
          attHost = new URL(att.url).host
        } catch {
          return NextResponse.json({ error: 'Invalid attachments' }, { status: 400 })
        }
        if (attHost !== supabaseHost) {
          return NextResponse.json({ error: 'Invalid attachments' }, { status: 400 })
        }
      }
      safeAttachments = attachments.map((att: { url: string; filename: string; size: number }) => ({
        url: att.url,
        filename: att.filename,
        size: att.size,
      }))
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

    const safeContent = sanitizeHtml(content ?? '')

    const { data: newMessage, error } = await admin
      .from('support_messages')
      .insert({
        participant_id: participantId,
        participant_type: participantType,
        participant_auth_id: participantAuthId,
        sender_role: isAdmin ? 'admin' : 'user',
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
