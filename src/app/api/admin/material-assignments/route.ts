import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { checkEmailDispatchLimit } from '@/lib/rateLimit'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentMaterialHomeworkAssignedEmailContent } from '@/lib/email/templates'
import { MaterialAssignmentCreateSchema } from '@/lib/validation/schemas'
import { runMaterialAssignPreflight } from '@/lib/materials/materialAssignPreflight'

const LOG_PREFIX = '[admin/material-assignments]'

// ---------------------------------------------------------------------------
// Admin-facing teaching-material homework grants (material_assignments).
//
//   POST - issue a grant to ANY current student.
//
// AUTHORISATION MODEL - deliberately the OPPOSITE of the teacher route, and the
// same model as /api/admin/library/assign:
//
//   requireAdmin() IS the gate. The insert runs on the SERVICE-ROLE client.
//
// Why it cannot be RLS here. The live INSERT policy ("Teachers assign material
// to own students", supabase/migrations/20260806100000_create_material_assignments.sql:57-87)
// is teacher-shaped and has three conjuncts: assigned_by = auth.uid(), a
// teacher-of-student relationship via trainings, AND the caller's own
// profiles.account_types containing 'teacher' or 'teacher_exam'. An admin who
// does not personally teach the student fails conjuncts 2 and 3, so a
// user-scoped insert could never succeed - and admin override, assigning to any
// student, is the entire point of this route. There is no is_admin() INSERT
// policy on the table.
//
// Because service role bypasses RLS, every check the teacher route inherits
// from the policy must be performed HERE, in TypeScript, before the write:
//   - requireAdmin()          - role 'admin' AND status 'current'
//   - the student gate below  - the student exists and is 'current'
//   - runMaterialAssignPreflight() - the sheet is active teaching material, the
//     attachment exists, is a PDF, and any page range fits the real document
// Nothing below may be relaxed on the assumption that "RLS will catch it".
// ---------------------------------------------------------------------------

// POST /api/admin/material-assignments
export async function POST(request: Request) {
  try {
    // Gate FIRST, before the body is even read. requireAdmin() applies the full
    // rule (role 'admin' AND status 'current') and returns null for anonymous
    // callers, non-admins and deactivated admins alike - it cannot distinguish
    // them, so this answers 401 exactly as every sibling /api/admin route does
    // (see api/admin/library/assign/route.ts:14-15). It THROWS on a failed
    // profiles read rather than silently demoting a real admin; the outer catch
    // turns that into a 500.
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const parsed = MaterialAssignmentCreateSchema.safeParse(body)
    if (!parsed.success) {
      // Same mapping as the teacher route: page-range rules are a semantic
      // conflict (422); a malformed id or index is a malformed request (400).
      // Both carry the schema's own message, which the modal renders verbatim.
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

    const adminClient = createAdminClient()

    // --- Student gate ---------------------------------------------------------
    // The teacher route gets this free from the RLS INSERT policy (a student it
    // cannot reach through trainings is simply denied). Service role has no such
    // backstop, so it is done here.
    //
    // 'current' is the canonical active-account rule, the same one
    // src/lib/access/accountStatus.ts:39-55 encodes for students and the same one
    // this page's own status badge reads: tested as === 'current', NEVER as
    // != 'former', because neither status column has a CHECK constraint. A
    // missing row and a non-current row are the SAME answer to the caller (404),
    // so nothing about which students exist leaks.
    //
    // Explicit column list - students carries column-level REVOKEs
    // (admin_notes, cancellation_policy) and select('*') is banned on it. The
    // email/full_name read here is reused by the notification block below, so
    // the student is looked up exactly once.
    const { data: student, error: studentError } = await adminClient
      .from('students')
      .select('id, full_name, email, status')
      .eq('id', student_id)
      .maybeSingle()

    if (studentError) {
      console.error(`${LOG_PREFIX} students lookup failed (student ${student_id}):`, studentError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    if (!student || student.status !== 'current') {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    // --- Read-only pre-flight validation --------------------------------------
    // Shared verbatim with the teacher route, so the two assign paths cannot
    // disagree about what is assignable. Returns the same statuses, bodies and
    // error codes (404 / 422 ATTACHMENT_NOT_PDF / 422 PDF_LOAD_FAILED /
    // 422 PAGE_RANGE_UNSATISFIABLE) and resolves attachment_name POSITIONALLY
    // from the current attachments array.
    const preflight = await runMaterialAssignPreflight(
      adminClient,
      {
        studySheetId: study_sheet_id,
        attachmentIndex: attachment_index,
        pageStart,
        pageEnd,
      },
      LOG_PREFIX
    )

    if (!preflight.ok) {
      return NextResponse.json(preflight.body, { status: preflight.status })
    }

    // --- The write (service role, post-gate) ----------------------------------
    // assigned_by is the ADMIN's auth uuid, taken from the verified session and
    // never from the body. profiles.id IS the auth uuid for a staff account, so
    // this satisfies the assigned_by -> profiles(id) foreign key.
    const { data: inserted, error: insertError } = await adminClient
      .from('material_assignments')
      .insert({
        student_id,
        study_sheet_id,
        attachment_index,
        attachment_name: preflight.attachmentName,
        page_start: pageStart,
        page_end: pageEnd,
        assigned_by: user.id,
      })
      .select('id')
      .maybeSingle()

    if (insertError) {
      // 23505 = material_assignments_live_unique, the partial unique index over
      // (student_id, study_sheet_id, attachment_index) WHERE revoked_at is null.
      // Same message as the teacher route.
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'This student already has a live assignment for this file. Revoke it first.' },
          { status: 409 }
        )
      }

      console.error(`${LOG_PREFIX} insert failed:`, insertError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    // No error and no row back. On the teacher route this means RLS filtered the
    // RETURNING row, which is a denial (403). Service role has no RLS filtering,
    // so here it can only be a fault - report it as one, and never as success.
    if (!inserted) {
      console.error(`${LOG_PREFIX} insert returned no row`)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    // --- Notification email (best-effort, never affects the response) ---------
    // The grant row already exists by this point, so NO outcome below may change
    // what this route returns: a rate-limit block, a failed lookup, a missing
    // address and a Resend failure all still yield the 201. Own try/catch so a
    // throw cannot fall into the outer handler and turn a written grant into a
    // 500. Revoke stays silent - only an insert notifies.
    //
    // Wording is deliberately identical to the teacher route's: the student is
    // told "your teacher" either way, which is accurate to them and keeps one
    // template for one event.
    try {
      // 20 dispatches per user per hour, the same bucket the teacher route uses.
      // A block SKIPS the send; it is never a 429, because the assignment itself
      // succeeded.
      const limit = await checkEmailDispatchLimit(user.id)
      if (limit.blocked) {
        console.error(
          `${LOG_PREFIX} email dispatch rate-limited, skipping send (assignment ${inserted.id})`
        )
      } else {
        // Sender display name from the caller's OWN profile row, keyed on the
        // verified session uuid - never from the request body, exactly as the
        // teacher route does it. Service role rather than a user-scoped client
        // only because requireAdmin() has already proved who this is and no
        // second client is needed. A lookup failure is not worth losing the
        // email over: continue with null, and the template renders the nameless
        // variant rather than an empty name slot.
        const { data: profile, error: profileError } = await adminClient
          .from('profiles')
          .select('full_name')
          .eq('id', user.id)
          .maybeSingle()

        if (profileError) {
          console.error(`${LOG_PREFIX} profiles lookup failed:`, profileError)
        }
        const senderName = profile?.full_name ?? null

        // The student row was already read (and its error handled) by the gate
        // above, so there is no second lookup to fail here - only a missing
        // address to report.
        if (!student.email) {
          console.error(
            `${LOG_PREFIX} no email address for student ${student_id}, skipping send`
          )
        } else {
          const subject = 'Lingualink Online - Your teacher has assigned you a homework task'
          await resend.emails.send({
            from: 'Lingualink Online <no-reply@lingualinkonline.com>',
            to: student.email,
            subject,
            html: buildEmailTemplate({
              recipientName: student.full_name,
              recipientFallback: 'Student',
              subject,
              bodyHtml: studentMaterialHomeworkAssignedEmailContent(senderName),
              contactEmail: 'support@lingualinkonline.com',
            }),
          })
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} email dispatch failed:`, err)
    }

    return NextResponse.json({ id: inserted.id }, { status: 201 })
  } catch (err) {
    console.error(`${LOG_PREFIX} unhandled POST failure:`, err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
