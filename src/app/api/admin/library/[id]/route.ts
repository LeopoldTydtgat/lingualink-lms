import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

const BUCKET = 'library-files'

// Supabase storage list() caps a page at 100 rows. Sheets realistically hold a
// handful of files; the page cap is a backstop against an unbounded loop, not a
// real limit. Hitting it means the prefix holds more objects than we are willing
// to enumerate — that fails the delete rather than orphaning the remainder.
const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

// PATCH /api/admin/library/[id] — update a study sheet
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  // Only allow fields that are safe to update — strip anything unexpected
  const allowed = ['title', 'category', 'level', 'difficulty', 'intro_text', 'content', 'allowed_roles', 'is_active', 'attachments', 'audience']
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  // Audience is an access boundary: accept only 'student' or 'staff'. Any other
  // value (or a malformed one) coerces to the fail-safe 'staff'. Absent = unchanged.
  if ('audience' in update) {
    update.audience = update.audience === 'student' ? 'student' : 'staff'
  }

  // Student worksheets must always carry a category and a level. study_sheets now
  // allows NULL category/level (for teacher private resources), and the DB CHECK
  // only constrains a non-null category - so nothing at the DB layer stops a PATCH
  // from stripping these off a student row. Enforce it here against the MERGED
  // result: any of the three fields absent from this patch keeps its current
  // value, so fetch the current row when we cannot decide from the patch alone.
  {
    const needCurrent = !('audience' in update) || !('category' in update) || !('level' in update)
    let current: { audience: string | null; category: string | null; level: string | null } | null = null
    if (needCurrent) {
      const { data: cur } = await supabase
        .from('study_sheets')
        .select('audience, category, level')
        .eq('id', id)
        .maybeSingle()
      current = cur
    }
    const resultAudience = 'audience' in update ? (update.audience as string) : current?.audience ?? null
    if (resultAudience === 'student') {
      const resultCategory = 'category' in update ? (update.category as string | null) : current?.category ?? null
      const resultLevel = 'level' in update ? (update.level as string | null) : current?.level ?? null
      // category '' would fail the study_sheets_category_check anyway, so reject
      // null AND empty. level has no CHECK and '' is the established "not
      // specified" value the create route and admin form still produce, so reject
      // only a null/missing level (the DDL-introduced hazard), not ''.
      const categoryOk = typeof resultCategory === 'string' && resultCategory.length > 0
      const levelOk = resultLevel != null
      if (!categoryOk || !levelOk) {
        return NextResponse.json(
          { error: 'Student worksheets require a category and a level.' },
          { status: 400 }
        )
      }
    }
  }

  // Exercises/MCQs now live in the activities table, never in study_sheets.content.
  // Content stores words only (vocabulary sheets); exercises is kept as an empty
  // array purely for the backward-compatible content shape the readers expect.
  const hasContent = 'content' in body
  if (hasContent) {
    const contentObj: Record<string, unknown> =
      body.content && typeof body.content === 'object' && !Array.isArray(body.content)
        ? (body.content as Record<string, unknown>)
        : {}
    update.content = {
      words: Array.isArray(contentObj.words) ? contentObj.words : [],
      exercises: [],
    }
  }

  update.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('study_sheets')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

// DELETE /api/admin/library/[id] — delete a study sheet, its assignments, and its files
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A non-uuid id can never name a row. Guarded explicitly rather than left to a
  // Postgres 22P02 cast error in whichever statement happens to run first — that
  // ordering is an accident, and it is the only thing keeping a junk id out of
  // the storage prefix built below.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Study sheet not found.' }, { status: 404 })
  }

  const adminClient = createAdminClient()

  // ── Order matters, and it is the whole point of this handler ──────────────
  // Storage runs FIRST, before anything is destroyed. NEW364: the sheet's files
  // live under the `${id}/` prefix in library-files and are reachable from no FK,
  // so nothing cascades them — deleting the row first would strand the bytes
  // forever, keyed by an id that no longer exists (and that a future sheet could
  // reuse). Storage must therefore come out cleanly before the row.
  //
  // It must also come out before the assignments delete below: every failure
  // path here returns 500, so any destructive step above them would be undone by
  // nothing and re-done by no retry. With storage first, a storage fault leaves
  // the sheet, its assignments, and its bytes all intact — genuinely retryable.
  const objectPaths: string[] = []
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data: objects, error: listError } = await adminClient.storage
      .from(BUCKET)
      .list(id, { limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE })

    // Fail closed on both an error and a null payload: an unreadable prefix is
    // indistinguishable from an empty one, and guessing "empty" orphans files.
    if (listError) {
      return NextResponse.json(
        { error: `Could not list this sheet's files: ${listError.message}` },
        { status: 500 }
      )
    }
    if (!objects) {
      return NextResponse.json(
        { error: "Could not list this sheet's files." },
        { status: 500 }
      )
    }

    objectPaths.push(...objects.map(obj => `${id}/${obj.name}`))

    if (objects.length < LIST_PAGE_SIZE) break

    if (page === MAX_LIST_PAGES - 1) {
      return NextResponse.json(
        { error: "This sheet has more files than can be cleaned up automatically. Remove them before deleting it." },
        { status: 500 }
      )
    }
  }

  // remove() is chunked to the same page size: one oversized request that the
  // storage API rejects would leave every listed object behind.
  for (let i = 0; i < objectPaths.length; i += LIST_PAGE_SIZE) {
    const { error: removeError } = await adminClient.storage
      .from(BUCKET)
      .remove(objectPaths.slice(i, i + LIST_PAGE_SIZE))

    if (removeError) {
      return NextResponse.json(
        { error: `Could not delete this sheet's files: ${removeError.message}` },
        { status: 500 }
      )
    }
  }

  // Assignments. The FK is ON DELETE CASCADE (baseline_schema.sql:1629), so the
  // row delete below would clear these anyway — this is belt and braces, kept
  // only because an unchecked failure here used to be swallowed entirely. It runs
  // AFTER storage precisely so it is never the casualty of a storage fault.
  const { error: assignmentsError } = await adminClient
    .from('assignments')
    .delete()
    .eq('study_sheet_id', id)

  if (assignmentsError) {
    return NextResponse.json(
      { error: `Could not delete this sheet's assignments: ${assignmentsError.message}` },
      { status: 500 }
    )
  }

  // The bytes are gone — the row can go. activities and sheet_tags cascade from
  // this delete (activity_attempts cascade via activities)
  // (20260715120000_new345_library_owner_tags_activities.sql; baseline_schema.sql).
  const { error } = await adminClient
    .from('study_sheets')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
