'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { Annotation } from '@/components/pdf/PdfViewer'

// ---------------------------------------------------------------------------
// Student homework-layer autosave for a teaching-material grant.
//
// Sibling of src/lib/lessons/saveLessonAnnotations.ts (the teacher's lesson
// layer). Same shape, same guarantees, different row: the homework layer lives
// ON the grant row itself (material_assignments.annotations), because the grant
// IS the permission slip and the student's work belongs to it.
//
// W1 (RLS must stay in force): every DB call here uses the USER-SCOPED client
// (createClient from server.ts), NEVER createAdminClient(). The gate on this
// write is the pair
//   - RLS policy "Students update own homework layer" (own students row AND
//     revoked_at is null), and
//   - the column-level `grant update (annotations, updated_at)` - the student
//     role physically cannot write revoked_at, page_start/page_end, or any
//     other column on this table.
// (supabase/migrations/20260806100000_create_material_assignments.sql:89-107.)
// The service-role client bypasses both and would make the entire gate
// decorative. No ownership, revocation or teaching-relationship logic is
// re-derived here, so this action can never disagree with the live policy - a
// revoked grant simply matches zero rows and is reported as not-saved.
//
// W2 (no wrong-row writes): the row is named by id and nothing else. There is
// no path from this action to another student's grant, because the policy's
// USING clause re-checks ownership on the server for every id the browser can
// invent. updated_at is set in code because this table has no updated_at
// trigger (the revoke route does the same - see
// api/teacher/material-assignments/[id]/route.ts:71-81).
// ---------------------------------------------------------------------------

// What the browser sends. `annotations` is stored VERBATIM: the page-index
// conversion (served index -> REAL document index) and the merge of any
// held-aside marks have ALREADY happened in the client wrapper, which is the
// only layer that knows the grant's page offset and the size of the served
// slice. Converting again here would double-shift every mark; converting
// INSTEAD of there is impossible, because a direct PostgREST PATCH (the student
// role holds the grant and the policy for it) would bypass this action
// entirely. So the stored contract - "page indices on the homework layer are
// REAL document pages" (material-assignment-file/[assignmentId]/route.ts:206-213,
// migration line 5) - is enforced at the one place that can honour it, and this
// action deliberately does not touch the payload.
export type SaveMaterialAnnotationsInput = {
  assignmentId: string
  annotations: Annotation[]
}

// What the client gets back, to drive the fail-safe indicator.
//  - 'saved'      : marks persisted on the grant row
//  - 'not_saving' : nothing was written (grant revoked, not this caller's,
//                   malformed input, or a DB error) - the badge must show
export type SaveMaterialAnnotationsResult =
  | { status: 'saved' }
  | { status: 'not_saving' }

const AssignmentIdSchema = z.string().uuid()

export async function saveMaterialAnnotations(
  input: SaveMaterialAnnotationsInput
): Promise<SaveMaterialAnnotationsResult> {
  // A server action is reachable by any authenticated session, so neither
  // argument is trusted. A non-uuid would reach Postgres as a 22P02 cast error
  // and surface as a thrown action; a non-array would be written into the jsonb
  // column as-is and break every later seed. Both are refused up front and
  // reported as not-saved - never as success.
  if (!AssignmentIdSchema.safeParse(input.assignmentId).success) {
    console.error('[saveMaterialAnnotations] refused: assignmentId is not a uuid')
    return { status: 'not_saving' }
  }
  if (!Array.isArray(input.annotations)) {
    console.error('[saveMaterialAnnotations] refused: annotations is not an array', {
      assignmentId: input.assignmentId,
    })
    return { status: 'not_saving' }
  }

  const supabase = await createClient()

  // W1: user-scoped client, so RLS re-checks ownership AND `revoked_at is null`
  // on this exact write. Only the two granted columns are set.
  //
  // toISOString() is correct here: updated_at is a timestamptz INSTANT, not a
  // local calendar-date construction (which is what the project's toISOString
  // ban covers).
  //
  // .select('id') returns the row only if the SELECT policy also admits it, and
  // maybeSingle() because zero rows is an expected outcome (revoked grant, not
  // this caller's row), not an exception.
  const { data, error } = await supabase
    .from('material_assignments')
    .update({
      annotations: input.annotations,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.assignmentId)
    .select('id')
    .maybeSingle()

  // No row back (RLS refused the write, or the grant was revoked mid-session) OR
  // a DB error: report not-saved so the badge appears - never silent success.
  // Observability: a legitimate refusal and a real defect (grant regression,
  // schema drift, network fault) both land here, so log the context. NEVER log
  // annotation CONTENT (user data, potentially large) - only its length.
  if (error || !data) {
    console.error('[saveMaterialAnnotations] update refused or failed', {
      assignmentId: input.assignmentId,
      annotationCount: input.annotations.length,
      error,
    })
    return { status: 'not_saving' }
  }

  return { status: 'saved' }
}
