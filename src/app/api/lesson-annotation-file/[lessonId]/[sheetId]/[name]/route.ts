import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const BUCKET = 'library-files'

type Attachment = {
  name: string
  url: string
  type: string
}

// GET /api/lesson-annotation-file/[lessonId]/[sheetId]/[name]
//
// Serves the bytes of a library PDF that a teacher marked up during a live
// lesson, so those marks can be reviewed read-only afterwards: by the student
// under Past Classes, and by the teacher (or an admin) on the class report.
// This is the ONE deliberate, narrow exception to the rule enforced by
// /api/library-file that students never receive staff-audience Teaching
// Material: here a student may see a staff PDF, but ONLY the specific
// attachment their own teacher annotated in their own past class.
//
// The third segment is the attachment's FILENAME, not its position in the
// sheet's attachments array. Annotation identity is the name end to end — the
// autosave upserts on (lesson_id, study_sheet_id, attachment_name) — because an
// admin reorder, a removal or a same-name re-upload shifts every later
// attachment's index while the filename stays put.
//
// AUTHORISATION MODEL — the whole gate is a single user-scoped, RLS-governed
// SELECT on lesson_annotations. This route holds NO role check of its own:
// every caller is governed by their own SELECT policy on that table, and the
// row's existence IS the grant.
//   - "Students read final lesson annotations after cutoff" returns a row ONLY
//     when the lesson's student_id is THIS caller AND the 15-minute post-class
//     cutoff has passed. That policy is untouched by this route also serving
//     teachers and admins: it remains the only thing deciding what a student
//     may read here, cutoff included.
//   - "Teachers read own lesson annotations" returns a row when the lesson's
//     teacher_id is THIS caller. No cutoff — a teacher reviews the marks from
//     their own class at any time.
//   - "Admins read all lesson annotations" returns a row when is_admin().
//   - No row from any of them means no access, for any caller: same generic 403.
//   - No ownership/cutoff/audience logic is re-derived in code, so this route can
//     never disagree with the live RLS policies. NEVER move this check onto the
//     admin/service-role client: that bypasses RLS and the entire gate.
//   - The service-role admin client is used ONLY after access is granted, purely
//     to read the attachment metadata and download the bytes from the private
//     bucket (the general audience gate in /api/library-file is left untouched).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lessonId: string; sheetId: string; name: string }> }
) {
  try {
    const { lessonId, sheetId, name } = await params

    // attachment_name is the gate key AND, further down, the value matched
    // against the sheet's attachments, so validate its charset up front with the
    // same rule applied at the storage boundary below. Anything else is refused
    // here and never reaches a query.
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // --- Auth wall: the caller must be logged in. ---
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // --- THE GATE (sole authorization) ---
    // User-scoped read: RLS decides. A missing row means "not this caller's lesson
    // / before cutoff / no such annotation" — all indistinguishable and all denied
    // with the same generic 403, so nothing about the sheet leaks.
    const { data: annotationRow } = await supabase
      .from('lesson_annotations')
      .select('id')
      .eq('lesson_id', lessonId)
      .eq('study_sheet_id', sheetId)
      .eq('attachment_name', name)
      .maybeSingle()

    if (!annotationRow) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // --- Access granted: resolve the attachment and stream the bytes ---
    // Service-role is used ONLY from here down (metadata + private-bucket download),
    // after the RLS gate above has already granted access.
    const adminClient = createAdminClient()
    const { data: sheet } = await adminClient
      .from('study_sheets')
      .select('is_active, attachments')
      .eq('id', sheetId)
      .maybeSingle()

    if (!sheet || sheet.is_active !== true) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []

    // Resolve WHICH attachment to serve. The name is the stable key: match the
    // requested filename against the sheet's CURRENT attachments so an admin
    // reorder/removal can't shift the teacher's marks onto a different same-sheet
    // PDF. It is the gate row's own attachment_name — the equality filter above is
    // what returned that row — so this serves exactly the annotated file and
    // nothing else. If the annotated file was since removed or renamed, find()
    // returns undefined and the validation below denies with 404. There is no
    // positional fallback: attachment_name is NOT NULL, so no row can lack one.
    const attachment = attachments.find((a) => a && a.name === name)
    // Re-validate the filename at this boundary (mirrors /api/library-file): the
    // admin library create/PATCH routes write the attachments array verbatim, so a
    // hostile or malformed name could otherwise reach the storage path ('../'
    // traversal) or the response header (quote/CRLF injection). Every real upload
    // already matches this charset, so the check rejects nothing legitimate.
    // This is deliberately the SECOND charset check: the first one screens the
    // request param, this one screens the STORED attachments entry that actually
    // builds the path and the header. Different inputs, different trust — keep both.
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(attachment.name)
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Build the storage path the same way the upload route does: {sheetId}/{name}.
    const storagePath = `${sheetId}/${attachment.name}`

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
