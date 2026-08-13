'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { SubmitReportSchema, type SubmitReportInput } from '@/lib/validation/schemas'
import { checkEmailDispatchLimit } from '@/lib/rateLimit'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentHomeworkAssignedEmailContent } from '@/lib/email/templates'

export async function reopenReport(reportId: string) {
  const supabase = await createClient()

  // Only admins can reopen reports — check the role first
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // A query error is a transient DB failure, not a missing row - it must surface
  // as an error rather than silently resolve isAdmin to false, which would deny a
  // real admin during a DB blip. Returned, not thrown: the caller has no
  // try/catch and a rejection would strand its Reopening state. A confirmed
  // zero-row profile keeps isAdmin false and hits the denial below unchanged.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[reports/actions] profiles lookup failed:', profileError)
    return { error: 'Something went wrong. Please try again.' }
  }

  // Mirror the admin route's exact admin check
  // (src/app/api/admin/reports/[id]/route.ts): role === 'admin'
  // status === 'current' is now required too, per the canonical rule in
  // lib/auth/requireAdmin.ts: authorised = required role AND active account.
  const isAdmin = profile?.role === 'admin' && profile?.status === 'current'

  if (!isAdmin) return { error: 'Not authorised' }

  // Flagged (never submitted) and completed (submitted but wrong) reports may
  // both be reopened - matches the admin route's guard, and the race predicate
  // below mirrors it too, so both admin reopen paths behave identically (NEW270).
  // Error bound, and maybeSingle because zero rows is a real outcome here.
  // .single() made an ordinary miss an error, and the discarded error meant a
  // transient DB fault rendered to the admin as 'Report not found' - a wrong
  // diagnosis of a recoverable problem. Mirrors the profiles lookup above.
  const { data: existing, error: existingError } = await supabase
    .from('reports')
    .select('id, status')
    .eq('id', reportId)
    .maybeSingle()

  if (existingError) {
    console.error('[reports/actions] reports lookup failed:', existingError)
    return { error: 'Something went wrong. Please try again.' }
  }

  if (!existing) return { error: 'Report not found' }
  if (existing.status !== 'flagged' && existing.status !== 'completed') {
    return { error: 'Only flagged or completed reports can be reopened' }
  }

  // completed_at is cleared so a reopened report carries no stale submitted
  // timestamp; complete_report_atomic stamps it fresh when the teacher re-files.
  // The status predicate guards the race between the check above and this write;
  // .select confirms a row was actually touched - zero rows means the status
  // changed underneath us (or the write silently matched nothing).
  const { data: updatedRows, error } = await supabase
    .from('reports')
    .update({
      status: 'reopened',
      flagged_at: null,
      completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)
    .in('status', ['flagged', 'completed'])
    .select('id')

  if (error) {
    // Raw Postgres text must not reach the admin: the caller renders
    // result.error verbatim in the card's error line. Logged instead.
    console.error('[reports/actions] reports update failed:', error)
    return { error: 'Something went wrong. Please try again.' }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { error: 'Report can no longer be reopened. Refresh and try again.' }
  }

  // Refresh the reports page so the list updates immediately
  revalidatePath('/reports')
  return { success: true }
}

export async function submitReport(reportId: string, payload: SubmitReportInput) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const parsed = SubmitReportSchema.safeParse(payload)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { error: first?.message ?? 'Invalid report payload' }
  }

  // Auth gate: caller must be the report's teacher or an admin.
  const { data: report, error: fetchErr } = await supabase
    .from('reports')
    .select('id, teacher_id, status, lesson_id')
    .eq('id', reportId)
    .single()

  if (fetchErr || !report) return { error: 'Report not found' }

  // A query error is a transient DB failure, not a missing row - it must surface
  // as an error rather than silently resolve isAdmin to false, which would deny
  // an admin submitting on someone else's behalf. Returned, not thrown: the
  // caller has no try/catch and a rejection would strand its Saving state.
  // A confirmed zero-row profile keeps isAdmin false and falls through to the
  // teacher_id check unchanged.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[reports/actions] profiles lookup failed:', profileError)
    return { error: 'Something went wrong. Please try again.' }
  }

  // Active-account gate covering BOTH arms below, admin and teacher alike, per the
  // canonical rule in lib/auth/requireAdmin.ts: authorised = role AND status.
  // complete_report_atomic is a pay path, so a former teacher must not file a
  // report on their old lessons, nor a deactivated admin on anyone's behalf.
  if (profile?.status !== 'current') {
    return { error: 'Not authorised' }
  }

  const isAdmin = profile?.role === 'admin'
  if (!isAdmin && report.teacher_id !== user.id) {
    return { error: 'Not authorised' }
  }

  // Decide the lesson status from the report payload.
  // did_class_happen=true             -> 'completed'
  // did_class_happen=false, student   -> 'student_no_show'
  // did_class_happen=false, teacher   -> 'teacher_no_show'
  let lessonStatus: 'completed' | 'student_no_show' | 'teacher_no_show'
  if (parsed.data.did_class_happen) {
    lessonStatus = 'completed'
  } else if (parsed.data.no_show_type === 'teacher') {
    lessonStatus = 'teacher_no_show'
  } else {
    lessonStatus = 'student_no_show'
  }

  // RPC writes the report fields and the lesson status atomically.
  // Cancelled lessons are protected by the RPC's WHERE clause.
  const { error: rpcErr } = await supabase.rpc('complete_report_atomic', {
    p_report_id: reportId,
    p_lesson_status: lessonStatus,
    p_report_payload: {
      did_class_happen: parsed.data.did_class_happen,
      no_show_type: parsed.data.no_show_type,
      feedback_text: parsed.data.feedback_text,
      additional_details: parsed.data.additional_details,
      level_data: parsed.data.level_data,
      student_confirmed: parsed.data.student_confirmed,
      impersonation_note: parsed.data.impersonation_note,
    },
  })

  // complete_report_atomic raises five exceptions. Three are unreachable from
  // here (the lesson-status allowlist, 'Not authenticated' and 'Not authorised'
  // are all settled by the gates above before the RPC is called). The two that
  // do reach a teacher are handled explicitly; anything else is an unexpected DB
  // failure whose raw Postgres text must not be shown.
  //
  // Matched on message text, not ERRCODE: the start-time guard and the state
  // guard both raise P0001, so the code cannot tell them apart. Giving them
  // distinct ERRCODEs would mean rewriting the RPC (DDL), which is not worth it
  // for message wording. If the RPC text ever drifts, the match falls through to
  // the generic branch - the teacher still gets a sane message, never a blob.
  if (rpcErr) {
    const raw = rpcErr.message ?? ''

    // Client rule 8 Aug, written for the teacher. Passed through verbatim.
    if (raw.startsWith('This class has not started yet')) {
      return { error: raw }
    }

    // Report already filed, or an admin changed its state underneath this form.
    // The raw text carries the report UUID and reads like a debug string.
    if (raw.includes('is not in pending or reopened state')) {
      return { error: 'This report has already been submitted, or its status changed while you were writing. Refresh the page to see the current version.' }
    }

    // Includes the RPC's own 'Report <uuid> not found' (raised when the report
    // has no matching lesson row) and every unexpected Postgres failure.
    console.error('[reports/actions] complete_report_atomic failed:', rpcErr)
    return { error: 'Something went wrong saving this report. Please try again.' }
  }

  // Homework-assigned notification.
  //
  // The email lives HERE and not in /api/teacher/assignments/reconcile, where
  // the assignment rows are actually written. The teacher assigns study sheets
  // from the report form's modal, which saves immediately, but the student must
  // not be told about homework for a class whose report has not been filed: the
  // teacher may still be adding and removing sheets, and until the report is in
  // the class is not finished.
  //
  // assignments.notified_at is the dedupe - NULL means "not announced yet".
  // Only unnotified rows are listed and only those rows are stamped, so several
  // modal saves, sheets added and taken away again before submit, and an
  // admin-reopened report resubmitted with extra sheets all still produce one
  // email each covering only what the student has not already heard about.
  //
  // The teacher's name comes from report.teacher_id, NOT the session user: an
  // admin may submit on the teacher's behalf, and the student's email has to
  // name their own teacher rather than whoever filed the paperwork.
  //
  // Applies on every successful submit whatever did_class_happen said - a
  // no-show report can carry homework rows too. Wholly non-blocking: the report
  // is already saved by the RPC above and nothing in here may change what this
  // action returns.
  try {
    if (report.lesson_id) {
      // Service role throughout: `authenticated` holds SELECT + INSERT on
      // assignments only (no UPDATE), so the notified_at stamp cannot run on
      // the user client, and the students email read needs it too - the same
      // pattern the reconcile route used. Explicit columns, never select('*').
      const adminClient = createAdminClient()

      const { data: pendingRows, error: pendingError } = await adminClient
        .from('assignments')
        .select('id, student_id, study_sheet_id')
        .eq('lesson_id', report.lesson_id)
        .is('notified_at', null)

      if (pendingError) {
        console.error(
          `[reports/actions] unnotified assignments read failed (report ${reportId}):`,
          pendingError
        )
      }

      const pending = (pendingRows ?? []) as {
        id: string
        student_id: string
        study_sheet_id: string
      }[]

      if (pending.length > 0) {
        // The titles are the whole point of this email, so a failed read must not
        // be papered over with an empty list. Nothing is sent and nothing is
        // stamped: the rows stay unnotified and a later resubmit of this report
        // retries the announcement, exactly like the rate-limit skip below. The
        // student sees the work in their Study tab either way - this email is a
        // nudge, not the delivery.
        const { data: sheetRows, error: sheetError } = await adminClient
          .from('study_sheets')
          .select('id, title')
          .in('id', pending.map(r => r.study_sheet_id))

        if (sheetError) {
          console.error(
            `[reports/actions] study sheet titles read failed (report ${reportId}); homework notification skipped:`,
            sheetError
          )
        } else {
          const titles = ((sheetRows ?? []) as { id: string; title: string }[]).map(r => r.title)

          // Every assignment on one lesson belongs to that lesson's student, so
          // the first row names the recipient.
          const { data: student } = await adminClient
            .from('students')
            .select('email, full_name')
            .eq('id', pending[0].student_id)
            .maybeSingle()

          if (student?.email) {
            const { data: teacherProfile } = await adminClient
              .from('profiles')
              .select('full_name')
              .eq('id', report.teacher_id)
              .maybeSingle()

            const limit = await checkEmailDispatchLimit(user.id)
            if (limit.blocked) {
              // Nothing is stamped, so the rows stay unnotified and a later
              // resubmit of this report retries the announcement.
              console.warn(
                `[reports/actions] email dispatch limit reached for user ${user.id}; report ${reportId} submitted, homework notification skipped`
              )
            } else {
              const subject = 'Lingualink Online - Your teacher has assigned new exercises'
              await resend.emails.send({
                from: 'Lingualink Online <no-reply@lingualinkonline.com>',
                to: student.email,
                subject,
                html: buildEmailTemplate({
                  recipientName: student.full_name,
                  recipientFallback: 'Student',
                  subject,
                  bodyHtml: studentHomeworkAssignedEmailContent(
                    teacherProfile?.full_name ?? 'Your teacher',
                    titles
                  ),
                  contactEmail: 'support@lingualinkonline.com',
                }),
              })

              // Stamped ONLY once the send has resolved without throwing. A throw
              // above lands in the catch with every row still unnotified, so the
              // next submit retries. A failure of the stamp itself is logged and
              // left alone: the worst case is one duplicate email on a resubmit,
              // which is not worth compensating for.
              const { error: stampError } = await adminClient
                .from('assignments')
                .update({ notified_at: new Date().toISOString() })
                .in('id', pending.map(r => r.id))

              if (stampError) {
                console.error(
                  `[reports/actions] notified_at stamp failed after a successful send (report ${reportId}):`,
                  stampError
                )
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[reports/actions] homework notification failed (report ${reportId}):`, err)
  }

  revalidatePath('/reports')
  revalidatePath(`/reports/${reportId}`)
  return { success: true }
}
