import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: NextRequest) {
  try {
    // 1. Verify the requesting user is authenticated
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // 2. Parse multipart form data
    const formData = await req.formData()
    const file = formData.get('file')

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
    }

    // 3. Client-side enforces 10MB; double-check server-side
    const MAX_SIZE = 10 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File must be under 10MB.' }, { status: 400 })
    }

    // 4. Upload to the 'messages' storage bucket
    const admin = createAdminClient()
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${user.id}/${timestamp}-${safeName}`
    const arrayBuffer = await file.arrayBuffer()

    const { error: uploadError } = await admin.storage
      .from('messages')
      .upload(path, arrayBuffer, { contentType: file.type })

    if (uploadError) {
      console.error('[POST /api/messages/upload] Storage error:', uploadError)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    // 5. Generate a signed URL valid for 7 days (bucket is private)
    const { data: signedData, error: signedError } = await admin.storage
      .from('messages')
      .createSignedUrl(path, 60 * 60 * 24 * 7)

    if (signedError || !signedData) {
      console.error('[POST /api/messages/upload] Signed URL error:', signedError)
      return NextResponse.json({ error: 'Could not generate download URL.' }, { status: 500 })
    }

    return NextResponse.json({
      url: signedData.signedUrl,
      filename: file.name,
      size: file.size,
    })
  } catch (err) {
    console.error('[POST /api/messages/upload] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
