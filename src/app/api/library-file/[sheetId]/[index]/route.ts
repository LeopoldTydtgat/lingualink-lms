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
    // Identify the caller. This route loads the sheet with the service-role
    // admin client, which BYPASSES RLS, so the study_sheets SELECT policies do
    // not govern it. We re-enforce those same tiers in this code (tier check
    // below). First: the caller must be logged in.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // Student = a row in `students` keyed by auth_user_id; teacher/admin = a row
    // in `profiles` keyed by id. We need role + account_types to tell
    // student / teacher / exam-teacher / admin apart for the tier check.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, account_types')
      .eq('id', user.id)
      .maybeSingle()

    // Neither a student nor a profile → denied outright, before any sheet is
    // loaded, so sheet existence never leaks. (Matches prior behaviour.)
    if (!student && !profile) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // --- Resolve the sheet and the attachment ---
    // Service-role load: we ran our own auth gate above, and the download below
    // needs the service role once the bucket is private. audience + allowed_roles
    // are loaded so the tier check below can run.
    const adminClient = createAdminClient()
    const { data: sheet } = await adminClient
      .from('study_sheets')
      .select('id, is_active, attachments, audience, allowed_roles')
      .eq('id', sheetId)
      .maybeSingle()

    if (!sheet || sheet.is_active !== true) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // --- Tier check: mirror the four study_sheets RLS SELECT tiers exactly ---
    // The admin client above bypassed RLS, so re-apply the same audience/role
    // gates. account_types / allowed_roles are Postgres text[]; a missing array
    // is treated as empty. Default deny: access only becomes true when a tier
    // grants it. Order matters — broadest matching role wins
    // (admin > exam teacher > teacher > student).
    const accountTypes: string[] = Array.isArray(profile?.account_types) ? profile.account_types : []
    const allowedRoles: string[] = Array.isArray(sheet.allowed_roles) ? sheet.allowed_roles : []
    const isStudentAudience = sheet.audience === 'student'

    let access = false
    if (profile?.role === 'admin' || accountTypes.includes('school_admin')) {
      access = true
    } else if (accountTypes.includes('teacher_exam')) {
      access = isStudentAudience || allowedRoles.includes('teacher') || allowedRoles.includes('teacher_exam')
    } else if (accountTypes.includes('teacher')) {
      access = isStudentAudience || allowedRoles.includes('teacher')
    } else if (student) {
      access = isStudentAudience
    }

    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
