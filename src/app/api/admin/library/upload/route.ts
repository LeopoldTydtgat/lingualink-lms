import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

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

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  return isAdmin ? user : null
}

// POST /api/admin/library/upload — upload a file to storage
export async function POST(request: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

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

  const filename = sanitizeFilename(file.name)
  const storagePath = `${sheetId}/${filename}`

  const adminClient = createAdminClient()

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const { error: uploadError } = await adminClient.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: urlData } = adminClient.storage
    .from(BUCKET)
    .getPublicUrl(storagePath)

  return NextResponse.json({
    name: filename,
    url: urlData.publicUrl,
    type: file.type,
  })
}

// DELETE /api/admin/library/upload — remove a file from storage
export async function DELETE(request: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

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

  const storagePath = `${sheet_id}/${sanitizeFilename(filename)}`
  const adminClient = createAdminClient()

  const { error } = await adminClient.storage
    .from(BUCKET)
    .remove([storagePath])

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
