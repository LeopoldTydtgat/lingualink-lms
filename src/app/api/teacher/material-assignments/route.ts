import { NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { MaterialAssignmentCreateSchema } from '@/lib/validation/schemas'

const BUCKET = 'library-files'

// Only the two fields this route reads. Teacher uploads store { name, type };
// admin-library uploads may carry more. Nothing here consumes anything else.
type Attachment = { name: string; type: string }

type StudentOption = { id: string; full_name: string }

const SheetIdSchema = z.string().uuid()

// ---------------------------------------------------------------------------
// Teacher-facing teaching-material homework grants (material_assignments).
//
//   GET  - the data behind the assign modal: assignable students + the live
//          grants already issued for one sheet.
//   POST - issue a grant.
//
// AUTHORISATION MODEL. Every gate on this route is RLS, evaluated on the
// USER-SCOPED client (createClient):
//   - the student picker is whatever the caller's own RLS lets them read;
//   - the assignment list is the material_assignments SELECT policies;
//   - the INSERT is the "Teachers assign material to own students" WITH CHECK
//     policy - teacher-of-student via trainings (legacy teacher_id OR the
//     training_teachers junction) AND an active, role-permitted sheet.
// The service-role client appears ONLY for read-only pre-flight validation
// (sheet metadata, the stored PDF's real page count). It NEVER performs the
// insert: moving the insert onto it would bypass the only authorisation gate
// this feature has.
// ---------------------------------------------------------------------------

// GET /api/teacher/material-assignments?sheet_id=<uuid>
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const parsedSheetId = SheetIdSchema.safeParse(
      new URL(request.url).searchParams.get('sheet_id')
    )
    if (!parsedSheetId.success) {
      // A non-uuid would otherwise reach Postgres as a 22P02 cast error and
      // surface as a 500.
      return NextResponse.json({ error: 'A valid sheet_id is required.' }, { status: 400 })
    }
    const sheetId = parsedSheetId.data

    // --- Assignable students -------------------------------------------------
    // TWO user-scoped reads, unioned, because the INSERT policy accepts TWO
    // teacher-of-student paths and no single RLS-scoped table exposes both:
    //
    //   (a) trainings, scoped by "Teachers can view own trainings"
    //       (trainings.teacher_id = auth.uid()) - the LEGACY link. Modern
    //       trainings are created without teacher_id
    //       (src/app/api/admin/students/route.ts:275-284), so this path alone
    //       returns an EMPTY picker for a normally-assigned teacher.
    //   (b) students, scoped by "Teachers read own students", which is the
    //       trainings x training_teachers JUNCTION - the same relationship
    //       get_teacher_training_ids() encodes in the INSERT policy.
    //
    // Both are user-scoped, so RLS remains the sole scoping mechanism and this
    // route never widens it; the union simply stops the picker being narrower
    // than what the INSERT policy would actually accept. An admin reads every
    // student under either path (they hold is_admin() SELECT policies on both
    // tables) - the INSERT policy still denies them any student they do not
    // teach, so the extra names are fail-closed noise, not a grant.
    //
    // Explicit column lists on both: students carries column-level REVOKEs
    // (admin_notes, cancellation_policy), so select('*') is banned there.
    const { data: trainingRows, error: trainingsError } = await supabase
      .from('trainings')
      .select('student_id, students ( id, full_name )')

    if (trainingsError) {
      console.error('[teacher/material-assignments] trainings lookup failed:', trainingsError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    const { data: studentRows, error: studentsError } = await supabase
      .from('students')
      .select('id, full_name')

    if (studentsError) {
      console.error('[teacher/material-assignments] students lookup failed:', studentsError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    type JoinedStudent = { id: string; full_name: string | null }
    type TrainingRow = {
      student_id: string | null
      students: JoinedStudent | JoinedStudent[] | null
    }

    // De-duplicated by student id: a student can hold several trainings, and the
    // two reads above overlap.
    const studentsById = new Map<string, StudentOption>()

    for (const row of ((trainingRows ?? []) as TrainingRow[])) {
      // Supabase returns nested joins as arrays - always flatten with an
      // Array.isArray() check. A null join means the student row itself is not
      // readable by this caller, so there is no name to offer: skip it.
      const joined = Array.isArray(row.students) ? row.students[0] : row.students
      if (!joined || typeof joined.id !== 'string') continue
      studentsById.set(joined.id, {
        id: joined.id,
        full_name: joined.full_name ?? 'Unnamed student',
      })
    }

    for (const row of ((studentRows ?? []) as JoinedStudent[])) {
      if (typeof row.id !== 'string') continue
      studentsById.set(row.id, {
        id: row.id,
        full_name: row.full_name ?? 'Unnamed student',
      })
    }

    const students = [...studentsById.values()].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    )

    // --- Live grants for this sheet ------------------------------------------
    // User-scoped: the material_assignments SELECT policies decide which rows a
    // caller sees (teacher -> their own students, admin -> all). Explicit column
    // list, never select('*') - the table carries a column-level UPDATE grant.
    // Revoked rows stay in the table as history and are filtered out here.
    const { data: assignmentRows, error: assignmentsError } = await supabase
      .from('material_assignments')
      .select('id, student_id, attachment_index, attachment_name, page_start, page_end, assigned_at')
      .eq('study_sheet_id', sheetId)
      .is('revoked_at', null)
      .order('assigned_at', { ascending: false })

    if (assignmentsError) {
      console.error('[teacher/material-assignments] material_assignments lookup failed:', assignmentsError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    type AssignmentRow = {
      id: string
      student_id: string
      attachment_index: number
      attachment_name: string
      page_start: number | null
      page_end: number | null
      assigned_at: string
    }

    // Student name joined HERE, from the list built above, rather than as a
    // nested select: a nested students(...) embed would be re-filtered by the
    // students RLS policy and could silently return null for a row the caller
    // can legitimately see. null name -> the client renders its own fallback.
    const assignments = ((assignmentRows ?? []) as AssignmentRow[]).map((row) => ({
      id: row.id,
      student_id: row.student_id,
      student_name: studentsById.get(row.student_id)?.full_name ?? null,
      attachment_index: row.attachment_index,
      attachment_name: row.attachment_name,
      page_start: row.page_start,
      page_end: row.page_end,
      assigned_at: row.assigned_at,
    }))

    return NextResponse.json({ students, assignments })
  } catch (err) {
    console.error('[teacher/material-assignments] unhandled GET failure:', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}

// POST /api/teacher/material-assignments
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const parsed = MaterialAssignmentCreateSchema.safeParse(body)
    if (!parsed.success) {
      // Page-range rules are a semantic conflict (422); a malformed id or index
      // is a malformed request (400). Both carry the schema's own message, which
      // the modal renders verbatim.
      const issue = parsed.error.issues[0]
      const isPageRangeIssue = issue.path[0] === 'page_start' || issue.path[0] === 'page_end'
      return NextResponse.json(
        { error: issue.message },
        { status: isPageRangeIssue ? 422 : 400 }
      )
    }

    const { student_id, study_sheet_id, attachment_index } = parsed.data
    const pageStart = parsed.data.page_start ?? null
    const pageEnd = parsed.data.page_end ?? null

    // --- Read-only pre-flight validation (service role) ----------------------
    // None of this is authorisation - the INSERT's RLS policy is. This only
    // stops a grant being written that the file route could never satisfy.
    const adminClient = createAdminClient()

    const { data: sheet, error: sheetError } = await adminClient
      .from('study_sheets')
      .select('id, is_active, audience, attachments')
      .eq('id', study_sheet_id)
      .maybeSingle()

    if (sheetError) {
      console.error('[teacher/material-assignments] study_sheets lookup failed:', sheetError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    // audience='staff' is what makes a sheet teaching material. A student
    // worksheet (audience='student') is assigned through the assignments table
    // by /api/teacher/library/assign, never as a page-scoped material grant.
    if (!sheet || sheet.is_active !== true || sheet.audience !== 'staff') {
      return NextResponse.json({ error: 'Teaching material not found.' }, { status: 404 })
    }

    const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []

    // Resolution is POSITIONAL here and name-first everywhere afterwards: the
    // teacher picks a position in the CURRENT attachments array, and the name
    // resolved from it is stored on the row so a later reorder/removal cannot
    // shift the grant onto a different PDF (see
    // /api/material-assignment-file/[assignmentId]). attachment_name is never
    // taken from the request body.
    const attachment = attachments[attachment_index]

    // Same filename charset gate the file route applies before building the
    // storage path - a name that fails it could never be served, so the grant
    // must not be written.
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(attachment.name)
    ) {
      return NextResponse.json({ error: 'That file is not on this sheet.' }, { status: 404 })
    }

    // Same PDF gate as the file route (attachment.type === 'application/pdf').
    // That route refuses anything else outright, so a non-PDF grant would be
    // permanently unserveable.
    if (attachment.type !== 'application/pdf') {
      return NextResponse.json(
        {
          error: 'Only PDF files can be assigned as homework.',
          code: 'ATTACHMENT_NOT_PDF',
        },
        { status: 422 }
      )
    }

    // --- Page range vs the REAL document -------------------------------------
    // Checked at assign time so a typo fails here, in front of the teacher,
    // instead of 422-ing the student when they open the homework. Skipped for a
    // whole-document grant (both null): there is no range to outrun, and the
    // file route resolves the range against the live file on every request
    // anyway.
    if (pageStart !== null && pageEnd !== null) {
      const storagePath = `${study_sheet_id}/${attachment.name}`
      const { data: fileData, error: downloadError } = await adminClient.storage
        .from(BUCKET)
        .download(storagePath)

      if (downloadError || !fileData) {
        console.error(
          `[teacher/material-assignments] storage download failed (sheet ${study_sheet_id}, file ${attachment.name}):`,
          downloadError
        )
        return NextResponse.json(
          {
            error: 'This PDF could not be read, so a page range cannot be assigned for it.',
            code: 'PDF_LOAD_FAILED',
          },
          { status: 422 }
        )
      }

      let pageCount: number
      try {
        const sourcePdf = await PDFDocument.load(new Uint8Array(await fileData.arrayBuffer()))
        pageCount = sourcePdf.getPageCount()
      } catch (loadError) {
        // Unreadable / encrypted source: the file route fails closed on the same
        // load, so never write a grant against it.
        console.error(
          `[teacher/material-assignments] PDF load failed (sheet ${study_sheet_id}, file ${attachment.name}):`,
          loadError
        )
        return NextResponse.json(
          {
            error: 'This PDF could not be read, so a page range cannot be assigned for it.',
            code: 'PDF_LOAD_FAILED',
          },
          { status: 422 }
        )
      }

      // pageEnd >= pageStart is already guaranteed by the schema, so bounding
      // the end bounds the whole range.
      if (pageCount < 1 || pageEnd > pageCount) {
        return NextResponse.json(
          {
            error: `This file has ${pageCount} page${pageCount === 1 ? '' : 's'}, so pages ${pageStart}-${pageEnd} cannot be assigned.`,
            code: 'PAGE_RANGE_UNSATISFIABLE',
          },
          { status: 422 }
        )
      }
    }

    // --- THE GATE: the insert itself, on the USER-SCOPED client ---------------
    // "Teachers assign material to own students" (WITH CHECK) is the sole
    // authorisation check: assigned_by = auth.uid(), a teacher-of-student
    // relationship via trainings, and an active sheet this account type may
    // assign. Nothing above re-derives any of that, so this route can never
    // disagree with the live policy.
    const { data: inserted, error: insertError } = await supabase
      .from('material_assignments')
      .insert({
        student_id,
        study_sheet_id,
        attachment_index,
        attachment_name: attachment.name,
        page_start: pageStart,
        page_end: pageEnd,
        assigned_by: user.id,
      })
      .select('id')
      .maybeSingle()

    if (insertError) {
      // 23505 = material_assignments_live_unique, the partial unique index over
      // (student_id, study_sheet_id, attachment_index) WHERE revoked_at is null.
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'This student already has a live assignment for this file. Revoke it first.' },
          { status: 409 }
        )
      }

      const denied =
        insertError.code === '42501' || /row-level security/i.test(insertError.message)
      if (denied) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      console.error('[teacher/material-assignments] insert failed:', insertError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    // No error and no row back: the RETURNING row was filtered out by RLS. Treat
    // it as a denial - never report success for a write we cannot confirm.
    if (!inserted) {
      console.error('[teacher/material-assignments] insert returned no row')
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ id: inserted.id }, { status: 201 })
  } catch (err) {
    console.error('[teacher/material-assignments] unhandled POST failure:', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
