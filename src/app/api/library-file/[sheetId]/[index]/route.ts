import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const BUCKET = 'library-files'

type Attachment = {
  name: string
  url: string
  type: string
}

// GET /api/library-file/[sheetId]/[index]
//
// Same-origin auth proxy for study-sheet files. The library-files bucket is
// private, so the public Supabase URL no longer resolves. This route puts the
// file behind our own auth wall and streams the bytes from storage using the
// service-role admin client.
//
// The storage path is derived server-side from the route's own sheetId plus the
// attachment filename looked up from the sheet row. The caller-supplied public
// URL is never trusted or parsed for authorisation, so a user can only ever
// reach a file that genuinely belongs to a sheet the row says it belongs to.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sheetId: string; index: string }> }
) {
  try {
    const { sheetId, index } = await params

    // --- Auth wall ---
    // Mirror the existing study-sheet page gates exactly, no tighter:
    // the caller must be a logged-in student OR a teacher/admin.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // A student is a row in `students` keyed by auth_user_id (see the student
    // study page); a teacher/admin is a row in `profiles` keyed by id (see the
    // admin library upload route). Either is allowed to view library files.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    let authorised = !!student
    if (!authorised) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .maybeSingle()
      authorised = !!profile
    }

    if (!authorised) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // --- Resolve the sheet and the attachment ---
    // Service-role load: we have already run our own auth gate above, and the
    // download below needs the service role anyway once the bucket is private.
    const adminClient = createAdminClient()
    const { data: sheet } = await adminClient
      .from('study_sheets')
      .select('id, is_active, attachments')
      .eq('id', sheetId)
      .maybeSingle()

    if (!sheet || sheet.is_active !== true) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []

    const idx = Number(index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const attachment = attachments[idx]
    // Re-validate the filename at this boundary instead of trusting it. The
    // upload route sanitises names to [a-zA-Z0-9._-], but the admin create/PATCH
    // library routes write the attachments array verbatim, so a hostile or
    // malformed name could otherwise reach the storage path ('../' traversal) or
    // the response header (quote/CRLF injection). Every real upload already
    // matches this charset, so the check rejects nothing legitimate.
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(attachment.name)
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Build the storage path the same way the upload route does: {sheetId}/{name}.
    const storagePath = `${sheetId}/${attachment.name}`

    // --- Stream the bytes from the private bucket ---
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from(BUCKET)
      .download(storagePath)

    if (downloadError || !fileData) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const arrayBuffer = await fileData.arrayBuffer()

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': attachment.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${attachment.name}"`,
        'Cache-Control': 'private, max-age=0, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    // Never leak storage paths or internal detail in the error body.
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
