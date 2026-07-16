import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireTeacher, type TeacherAuth } from '@/lib/auth/requireTeacher'
import { magicMatchesMime } from '@/lib/file-magic'

// Local copies of the admin upload route's constants - deliberately duplicated
// rather than imported, so the two routes can diverge independently.
const BUCKET = 'library-files'

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

function sanitizeFilename(name: string): string {
  // Replace path separators and other unsafe characters, preserve extension
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_')
}

type Attachment = { name: string; type: string }

// Fetches the sheet through the USER-SCOPED client and confirms the caller owns
// it. Returns the current attachments on success, or null when the sheet does
// not exist OR is not owned by the caller - the two are not distinguished, so no
// existence oracle leaks. Ownership is checked EXPLICITLY (owner_id === user.id)
// and not left to RLS: a teacher's SELECT tier also returns admin sheets
// (owner_id IS NULL), which the teacher must never be able to write files into.
async function loadOwnedSheet(
  supabase: TeacherAuth['supabase'],
  sheetId: string,
  userId: string
): Promise<{ attachments: Attachment[] } | null> {
  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, owner_id, attachments')
    .eq('id', sheetId)
    .maybeSingle()

  if (!sheet || sheet.owner_id !== userId) return null

  const attachments: Attachment[] = Array.isArray(sheet.attachments)
    ? (sheet.attachments as Attachment[])
    : []
  return { attachments }
}

// POST /api/teacher/library/upload - upload a file into an OWNED sheet.
export async function POST(request: Request) {
  const auth = await requireTeacher()
  if (!auth) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { user, supabase } = auth

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const sheetId = formData.get('sheet_id') as string | null

  if (!file || !sheetId) {
    return NextResponse.json({ error: 'file and sheet_id are required' }, { status: 400 })
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'Unsupported file type. Allowed: PDF, DOC, DOCX, PPT, PPTX' },
      { status: 400 }
    )
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds the 10 MB limit' }, { status: 400 })
  }

  // Ownership gate BEFORE any storage operation. 404 covers both "no such
  // sheet" and "not yours" - no existence oracle.
  const owned = await loadOwnedSheet(supabase, sheetId, user.id)
  if (!owned) return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })

  const filename = sanitizeFilename(file.name)
  const storagePath = `${sheetId}/${filename}`

  // Does this filename already have a live attachment entry? upsert below
  // overwrites the bytes of a pre-existing file, so on a later failure we must
  // NOT remove those bytes - the row still references them.
  const wasExisting = owned.attachments.some((a) => a?.name === filename)

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Magic-byte verification: file.type is client-controlled, so confirm the
  // leading bytes match the claimed MIME before writing to storage.
  if (!magicMatchesMime(buffer, file.type)) {
    return NextResponse.json({ error: 'File contents do not match the declared type.' }, { status: 400 })
  }

  // Storage has no RLS tiers here, so the write uses the service-role client -
  // but ONLY now that ownership above has passed. upsert: true is safe ONLY
  // because the path is pinned to `${sheetId}/...` for a sheet we have proven the
  // caller owns; there is no way to overwrite another owner's object.
  const adminClient = createAdminClient()
  const { error: uploadError } = await adminClient.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  // Record the attachment on the sheet through the USER-SCOPED client, so the
  // "Teachers update own sheets" WITH CHECK policy re-verifies ownership +
  // audience='staff' at write time. Dedupe by name so re-uploading the same
  // filename (which upsert overwrote in storage) never doubles the array entry -
  // the library-file proxy indexes attachments positionally.
  const attachment: Attachment = { name: filename, type: file.type }
  const nextAttachments = [
    ...owned.attachments.filter((a) => a?.name !== filename),
    attachment,
  ]

  const { error: attachError } = await supabase
    .from('study_sheets')
    .update({ attachments: nextAttachments })
    .eq('id', sheetId)

  if (attachError) {
    // NEW364: a brand-new object -> remove it before failing (no orphan). A
    // pre-existing name means upsert overwrote a file the row still references:
    // its entry is still valid and the bytes are simply updated, so leave it -
    // removing it would break the live reference. Retry-safe either way.
    if (!wasExisting) {
      await adminClient.storage.from(BUCKET).remove([storagePath])
    }
    return NextResponse.json({ error: attachError.message }, { status: 500 })
  }

  // Private bucket - no public URL is returned or stored. Access is via the
  // library-file auth proxy, which rebuilds the path from sheetId + name.
  return NextResponse.json(attachment)
}

// DELETE /api/teacher/library/upload - remove a file from an OWNED sheet.
export async function DELETE(request: Request) {
  const auth = await requireTeacher()
  if (!auth) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { user, supabase } = auth

  let body: { sheet_id?: string; filename?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { sheet_id, filename } = body
  if (!sheet_id || !filename) {
    return NextResponse.json({ error: 'sheet_id and filename are required' }, { status: 400 })
  }

  // Ownership gate BEFORE any storage operation. 404 covers both cases.
  const owned = await loadOwnedSheet(supabase, sheet_id, user.id)
  if (!owned) return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })

  const safeName = sanitizeFilename(filename)
  const storagePath = `${sheet_id}/${safeName}`
  const adminClient = createAdminClient()

  // Storage first (NEW364 ordering): remove the bytes, then prune the row's
  // reference. This route is the sole maintainer of teacher-sheet attachments
  // (there is no client PATCH path), so it must keep the array truthful - a
  // stale entry would make the proxy 404 at that index. Storage remove is
  // idempotent (removing an absent path is not an error), so a failure of the
  // attachments prune below is retry-safe.
  const { error: removeError } = await adminClient.storage
    .from(BUCKET)
    .remove([storagePath])

  if (removeError) {
    return NextResponse.json({ error: removeError.message }, { status: 500 })
  }

  const nextAttachments = owned.attachments.filter((a) => a?.name !== safeName)
  const { error: attachError } = await supabase
    .from('study_sheets')
    .update({ attachments: nextAttachments })
    .eq('id', sheet_id)

  if (attachError) {
    return NextResponse.json({ error: attachError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
