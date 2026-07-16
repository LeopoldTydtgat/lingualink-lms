import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireTeacher } from '@/lib/auth/requireTeacher'

const BUCKET = 'library-files'

// Supabase storage list() caps a page at 100 rows; the page loop is a backstop
// against an unbounded prefix, mirroring the admin delete route.
const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

type Attachment = { name: string; type: string }

// POST /api/teacher/library/duplicate - copy an accessible sheet into the
// caller's OWN private library as a fresh staff-audience sheet.
export async function POST(request: Request) {
  const auth = await requireTeacher()
  if (!auth) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { user, supabase } = auth

  let body: { sheet_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { sheet_id } = body
  if (!sheet_id || !z.string().uuid().safeParse(sheet_id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  // Fetch the source through the USER-SCOPED client: RLS decides accessibility.
  // If the caller's read tiers do not return the row, the sheet does not exist
  // as far as they are concerned - 404, no existence oracle.
  const { data: source } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, intro_text, content, attachments')
    .eq('id', sheet_id)
    .maybeSingle()

  if (!source) return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })

  const sourceAttachments: Attachment[] = Array.isArray(source.attachments)
    ? (source.attachments as Attachment[])
    : []

  // Create the copy through the USER-SCOPED client so the "Teachers insert own
  // sheets" WITH CHECK policy gates it. The DB mints the id.
  //
  // Deliberately NOT copied - and why:
  //   - activities  - carry answer keys (excluded from the authenticated SELECT
  //                   grant) and student attempts; they are an admin authoring
  //                   artifact, not portable prep.
  //   - tags/sheet_tags - admin-curated taxonomy, not owned by the teacher.
  //   - assignments - a private staff copy is unassignable by design.
  //   - allowed_roles - reset to the default below, not inherited.
  // Only the plain content jsonb (words + empty exercises) and file attachments
  // travel with the copy.
  const { data: created, error: insertError } = await supabase
    .from('study_sheets')
    .insert({
      title: `${source.title} (Copy)`,
      category: source.category,
      level: typeof source.level === 'string' ? source.level : '',
      difficulty: typeof source.difficulty === 'number' ? source.difficulty : null,
      intro_text: source.intro_text ?? null,
      content: source.content ?? { words: [], exercises: [] },
      // Server-fixed, never inherited from the source:
      owner_id: user.id,
      audience: 'staff',
      is_active: true,
      // Default, set explicitly. Required so the owner's own SELECT tier for a
      // staff-audience sheet (allowed_roles @> ['teacher']) returns the row -
      // both for the RETURNING below and for later file access via the proxy.
      allowed_roles: ['teacher', 'teacher_exam'],
    })
    .select('id, title, category, level, difficulty')
    .single()

  if (insertError) {
    const denied = insertError.code === '42501' || /row-level security/i.test(insertError.message)
    return NextResponse.json(
      { error: denied ? 'Forbidden' : insertError.message },
      { status: denied ? 403 : 500 }
    )
  }
  if (!created) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const newId = created.id as string
  const adminClient = createAdminClient()

  // Deletes the new row via the ADMIN client - teachers have NO DELETE policy on
  // study_sheets (D4: soft-delete only), so the user-scoped client cannot roll
  // back its own just-created row. Ownership is certain: we created newId with
  // owner_id = user.id moments ago in this request.
  const rollback = async (copiedPaths: string[]) => {
    if (copiedPaths.length > 0) {
      await adminClient.storage.from(BUCKET).remove(copiedPaths)
    }
    await adminClient.from('study_sheets').delete().eq('id', newId)
  }

  // Enumerate the source's storage objects with the admin client (storage has no
  // RLS here; the source-read gate above already authorised access).
  const sourceObjects: string[] = []
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data: objects, error: listError } = await adminClient.storage
      .from(BUCKET)
      .list(source.id, { limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE })

    // Fail closed on error OR null: an unreadable prefix is indistinguishable
    // from an empty one, and guessing "empty" would ship a copy missing files.
    if (listError || !objects) {
      await rollback([])
      return NextResponse.json(
        { error: `Could not read the source sheet's files: ${listError?.message ?? 'unknown error'}` },
        { status: 500 }
      )
    }

    sourceObjects.push(...objects.map((obj) => obj.name))

    if (objects.length < LIST_PAGE_SIZE) break

    if (page === MAX_LIST_PAGES - 1) {
      await rollback([])
      return NextResponse.json(
        { error: 'The source sheet has more files than can be duplicated automatically.' },
        { status: 500 }
      )
    }
  }

  // Preserve each object's declared content type from the source attachments.
  const typeByName = new Map<string, string>()
  for (const a of sourceAttachments) {
    if (a && typeof a.name === 'string' && typeof a.type === 'string') typeByName.set(a.name, a.type)
  }

  // Copy each object into the new prefix, tracking what we have written so any
  // failure can undo it (NEW364: no partial copy ever survives).
  const copiedPaths: string[] = []
  for (const name of sourceObjects) {
    const from = `${source.id}/${name}`
    const to = `${newId}/${name}`

    const { data: blob, error: downloadError } = await adminClient.storage
      .from(BUCKET)
      .download(from)

    if (downloadError || !blob) {
      await rollback(copiedPaths)
      return NextResponse.json({ error: "Could not copy the source sheet's files." }, { status: 500 })
    }

    const contentType = typeByName.get(name) ?? blob.type ?? 'application/octet-stream'
    const fileBuffer = Buffer.from(await blob.arrayBuffer())

    const { error: uploadError } = await adminClient.storage
      .from(BUCKET)
      .upload(to, fileBuffer, { contentType, upsert: false })

    if (uploadError) {
      await rollback(copiedPaths)
      return NextResponse.json({ error: "Could not copy the source sheet's files." }, { status: 500 })
    }

    copiedPaths.push(to)
  }

  // Strip to clean {name, type} entries. The bucket is private and the proxy
  // keys on name; admin-created source rows carry a legacy `url` field that is
  // junk pointing at the SOURCE prefix and must not be inherited.
  const cleanAttachments = sourceAttachments
    .filter((a) => a && typeof a.name === 'string' && typeof a.type === 'string')
    .map((a) => ({ name: a.name, type: a.type }))

  // Record the copied attachments on the new row through the USER-SCOPED client
  // (the update policy re-verifies ownership + audience='staff').
  const { error: attachError } = await supabase
    .from('study_sheets')
    .update({ attachments: cleanAttachments })
    .eq('id', newId)

  if (attachError) {
    await rollback(copiedPaths)
    return NextResponse.json({ error: attachError.message }, { status: 500 })
  }

  return NextResponse.json(created, { status: 201 })
}
