import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const BUCKET = 'library-files'

type Attachment = {
  name: string
  url: string
  type: string
}

// GET /api/lesson-annotation-file/[lessonId]/[sheetId]/[index]
//
// Serves the bytes of a library PDF that a teacher marked up during a live
// lesson, so the student can review it read-only under Past Classes. This is the
// ONE deliberate, narrow exception to the rule enforced by /api/library-file that
// students never receive staff-audience Teaching Material: here a student may see
// a staff PDF, but ONLY the specific attachment their own teacher annotated in
// their own past class.
//
// AUTHORISATION MODEL — the whole gate is a single user-scoped, RLS-governed
// SELECT on lesson_annotations:
//   - The check runs on the USER-SCOPED client (createClient), so the policy
//     "Students read final lesson annotations after cutoff" governs it. That
//     policy returns a row ONLY when (lessonId, sheetId, index) is an annotation
//     on a lesson whose student_id is THIS caller AND the 15-minute post-class
//     cutoff has passed. The row's existence IS the grant.
//   - No ownership/cutoff/audience logic is re-derived in code, so this route can
//     never disagree with the live RLS policy. NEVER move this check onto the
//     admin/service-role client: that bypasses RLS and the entire gate.
//   - The service-role admin client is used ONLY after access is granted, purely
//     to read the attachment metadata and download the bytes from the private
//     bucket (the general audience gate in /api/library-file is left untouched).
//
// This route is scoped to STUDENTS (see the guard below). Teachers/admins are
// refused here and use their existing paths (dashboard seed + /api/library-file).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lessonId: string; sheetId: string; index: string }> }
) {
  try {
    const { lessonId, sheetId, index } = await params

    // attachment_index is part of the gate key, so parse + validate it up front.
    const idx = Number(index)
    if (!Number.isInteger(idx) || idx < 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // --- Auth wall: the caller must be logged in. ---
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // Scope this route to STUDENTS. lesson_annotations also has teacher/admin
    // SELECT policies with NO cutoff, so a teacher/admin hitting this route would
    // be gated by THOSE instead of the student read-after-cutoff policy. Because
    // the teacher INSERT policy does not verify study-sheet access, a teacher
    // could otherwise self-mint a row for an arbitrary study_sheet UUID and read
    // its private bytes here, bypassing the audience gate /api/library-file
    // enforces for teachers. Students have NO write policy and cannot mint rows,
    // so restricting to students makes the student policy the only path through —
    // which is exactly this route's purpose.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()
    if (!student) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
      .eq('attachment_index', idx)
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
    if (idx >= attachments.length) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const attachment = attachments[idx]
    // Re-validate the filename at this boundary (mirrors /api/library-file): the
    // admin library create/PATCH routes write the attachments array verbatim, so a
    // hostile or malformed name could otherwise reach the storage path ('../'
    // traversal) or the response header (quote/CRLF injection). Every real upload
    // already matches this charset, so the check rejects nothing legitimate.
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
