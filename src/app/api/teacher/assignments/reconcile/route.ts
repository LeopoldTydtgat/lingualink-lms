import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/teacher/assignments/reconcile
//
// Reconciles the study sheets assigned to ONE lesson: the body carries the FULL
// desired set, and this route derives the add/remove diff itself from a fresh
// read. It replaces the browser-side save in AssignStudySheetsModal, whose
// un-assign half could never work: `authenticated` holds SELECT + INSERT on
// public.assignments only (update and delete were revoked in
// 20260731090000_rls_grants_hardening_session.sql, and no DELETE policy exists),
// so the modal's DELETE failed permanently and silently reported a save.
//
// AUTHORISATION MODEL - the writes and the check are deliberately split, the
// same shape as DELETE /api/teacher/material-assignments/[id]:
//   - Both writes run on the service-role client, because the browser role
//     cannot delete at all and the insert must be checked against a student id
//     this route derives rather than one the caller supplies.
//   - Service role bypasses RLS, so the relationship check happens FIRST, and
//     the only way it cannot drift from the live policy: a user-scoped SELECT of
//     the lesson row. The lessons SELECT policies ("Teachers see own lessons" ->
//     teacher_id = auth.uid(), "Admins can read all lessons" -> is_admin()) ARE
//     the check. A lesson this caller cannot read is a 404, indistinguishable
//     from "no such lesson", so nothing leaks.
//
// That gate also reproduces the caller arm of the assignments INSERT policy
// (20260811100000) exactly. The policy admits an insert when the caller is an
// admin, OR is linked to the student through trainings, OR is the teacher of the
// referenced lesson AND that lesson belongs to the same student. Here the lesson
// is read under RLS and student_id is taken FROM that row, so a teacher can only
// ever land on the third arm and an admin on the first. The policy's SHEET arm
// (active, audience='student', owner_id is null) is re-applied in JS below,
// since a service-role insert is not policy-checked.
//
// Serves teachers and admins alike: the only caller, the class report page,
// admits both.
//
// NO EMAIL IS SENT FROM HERE, and none is sent anywhere else either: no
// homework email exists on any path any more, all of them having been removed by
// client decision. The student learns about new work in the portal - the
// assignments appear in their Study tab and in their What's New feed.

const ReconcileSchema = z.object({
  lesson_id: z.string().uuid(),
  // The full desired set for the lesson. An empty array is legitimate - it means
  // "un-assign everything". The ceiling is a sanity bound on a bulk write, not a
  // product rule.
  sheet_ids: z.array(z.string().uuid()).max(50),
})

type CurrentRow = {
  id: string
  study_sheet_id: string
  marked_done_at: string | null
}

type SheetRow = {
  id: string
  title: string
  is_active: boolean | null
  audience: string | null
  owner_id: string | null
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    // 1. Session. A distinct code, not prose: the modal tells the teacher to
    // sign in again rather than to retry, which would never work.
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'AUTH' }, { status: 401 })
    }

    // 2. Role gate. Mirrors /api/teacher/library/assign: a query error is a
    // transient DB failure, not a missing row - it must 500, never fall through
    // to the 403 denial below.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      console.error('[teacher/assignments/reconcile] profiles lookup failed:', profileError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    const isAuthorized = profile?.role === 'teacher' || profile?.role === 'admin'
    if (!profile || !isAuthorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const rawBody = await request.json().catch(() => null)
    const parsed = ReconcileSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A lesson id and a list of study sheet ids are required.' },
        { status: 400 }
      )
    }

    const lessonId = parsed.data.lesson_id
    // Deduped: a repeated id in the body would otherwise become two identical
    // rows, since nothing on the table stops it.
    const desired = Array.from(new Set(parsed.data.sheet_ids))
    const desiredSet = new Set(desired)

    // 3. THE GATE: user-scoped read, RLS decides. maybeSingle - zero rows is the
    // expected "not yours / no such lesson" outcome, not an exception. Explicit
    // column list, never select('*').
    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('id, student_id, teacher_id, status')
      .eq('id', lessonId)
      .maybeSingle()

    if (lessonError) {
      console.error(
        `[teacher/assignments/reconcile] lesson lookup failed (lesson ${lessonId}):`,
        lessonError
      )
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    if (!lesson) {
      return NextResponse.json({ error: 'Class not found.' }, { status: 404 })
    }

    const adminClient = createAdminClient()

    // 4. Fresh read of what is actually assigned to this lesson right now. The
    // diff is derived here rather than trusted from the client: the modal's
    // `alreadyAssigned` prop is a snapshot from page load and can be stale, and
    // re-deriving is what makes a retry after a partial failure idempotent.
    const { data: currentRows, error: currentError } = await adminClient
      .from('assignments')
      .select('id, study_sheet_id, marked_done_at')
      .eq('lesson_id', lessonId)

    if (currentError) {
      console.error(
        `[teacher/assignments/reconcile] current assignments read failed (lesson ${lessonId}):`,
        currentError
      )
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    const current = (currentRows ?? []) as CurrentRow[]
    const currentSheetIds = new Set(current.map(r => r.study_sheet_id))

    const toAdd = desired.filter(id => !currentSheetIds.has(id))
    const toRemove = current.filter(r => !desiredSet.has(r.study_sheet_id))

    // 5. Completed work is not removable. The delete below is a HARD delete, and
    // activity_attempts.assignment_id is ON DELETE SET NULL, so removing a row
    // the student has already finished would orphan their attempts. Nothing is
    // written at all in this case - not even the additions - so the modal can
    // name the offending sheets and the teacher can re-select them and save
    // again with the rest of their edit intact.
    const blocked = toRemove.filter(r => r.marked_done_at !== null)
    if (blocked.length > 0) {
      return NextResponse.json(
        {
          error: 'COMPLETED_ASSIGNMENT',
          blocked_study_sheet_ids: blocked.map(r => r.study_sheet_id),
        },
        { status: 409 }
      )
    }

    // 6. Sheet validation for the additions. The service-role insert is not
    // policy-checked, so the sheet arm of the INSERT policy is re-applied here:
    // only active, admin-published, student-audience sheets are assignable.
    // Teacher-owned prep is always audience='staff' and must never reach a
    // student. Same predicate as /api/teacher/library/assign.
    if (toAdd.length > 0) {
      const { data: sheetRows, error: sheetError } = await adminClient
        .from('study_sheets')
        .select('id, title, is_active, audience, owner_id')
        .in('id', toAdd)

      if (sheetError) {
        console.error(
          `[teacher/assignments/reconcile] study sheet validation failed (lesson ${lessonId}):`,
          sheetError
        )
        return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
      }

      const assignable = new Map<string, string>()
      for (const sheet of (sheetRows ?? []) as SheetRow[]) {
        if (sheet.is_active === true && sheet.audience === 'student' && sheet.owner_id === null) {
          assignable.set(sheet.id, sheet.title)
        }
      }

      // A missing row and a row failing the predicate are the same refusal: the
      // id names nothing this caller may hand to a student.
      const rejected = toAdd.filter(id => !assignable.has(id))
      if (rejected.length > 0) {
        return NextResponse.json(
          { error: 'Some of these sheets cannot be assigned to students.', rejected },
          { status: 400 }
        )
      }
    }

    // 7. INSERT FIRST. student_id comes from the gated lesson row and assigned_by
    // from the session user - never from the body, so neither can be forged.
    // .select('id') proves rows actually landed: a service-role insert that
    // silently matched nothing must not be reported as a save.
    if (toAdd.length > 0) {
      const nowIso = new Date().toISOString()
      const { data: inserted, error: insertError } = await adminClient
        .from('assignments')
        .insert(
          toAdd.map(sheetId => ({
            lesson_id: lessonId,
            student_id: lesson.student_id,
            study_sheet_id: sheetId,
            assigned_by: user.id,
            assigned_at: nowIso,
          }))
        )
        .select('id')

      if (insertError) {
        console.error(
          `[teacher/assignments/reconcile] insert failed (lesson ${lessonId}):`,
          insertError
        )
        return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
      }
      if ((inserted ?? []).length !== toAdd.length) {
        console.error(
          `[teacher/assignments/reconcile] insert row count mismatch (lesson ${lessonId}): expected ${toAdd.length}, got ${(inserted ?? []).length}`
        )
        return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
      }
    }

    // 8. DELETE SECOND, by primary key. The ordering is deliberate: a failure
    // after the insert leaves EXTRA rows, which the fresh read in step 4 cleans
    // up on the next save, whereas deleting first and then failing to insert
    // would destroy assignments the teacher meant to keep. Deleting by id rather
    // than by (lesson_id, study_sheet_id) also cannot touch a row that appeared
    // between the read and this write.
    if (toRemove.length > 0) {
      const removeIds = toRemove.map(r => r.id)
      const { data: deleted, error: deleteError } = await adminClient
        .from('assignments')
        .delete()
        .in('id', removeIds)
        .select('id')

      if (deleteError) {
        console.error(
          `[teacher/assignments/reconcile] delete failed (lesson ${lessonId}):`,
          deleteError
        )
        return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
      }
      if ((deleted ?? []).length !== removeIds.length) {
        console.error(
          `[teacher/assignments/reconcile] delete row count mismatch (lesson ${lessonId}): expected ${removeIds.length}, got ${(deleted ?? []).length}`
        )
        return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
      }
    }

    return NextResponse.json({ added: toAdd.length, removed: toRemove.length })
  } catch (err) {
    // Nothing raw from Postgres reaches the client: the shape of a failed query
    // is not the caller's business, and the message can carry column names.
    console.error('[teacher/assignments/reconcile] unhandled failure:', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
