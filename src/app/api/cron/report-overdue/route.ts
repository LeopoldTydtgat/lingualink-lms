import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate, teacherReportForfeitedEmailContent } from '@/lib/email/templates'
import { verifyCronAuth } from '@/lib/cron-auth'
import { createPendingReport } from '@/lib/reports/createPendingReport'

// Daily cron. For each report that is still 'pending' more than 12 hours after
// its lesson ended, it flags the report (status -> 'flagged'; this is the pay
// decision), emails the teacher that the reporting window was missed, and flips
// lessons.report_overdue_sent so the row is not revisited on later runs.
//
// 'reopened' reports are skipped entirely: an admin deliberately re-opened them,
// so they must never be auto-flagged again.
//
// Iterates reports (not lessons). A lesson reaches 'completed' (paid) ONLY via
// complete_report_atomic on report submission; an unreported past class stays
// 'scheduled' and already bills 0 under "no report = no pay" (auto-complete-lessons
// is disabled -- NEW178 -- so nothing silently completes it). The 'pending' report
// row is the canonical marker of such a class, so we scan reports, not lesson
// status. The flag + email here are the visibility/notification layer; pay is
// withheld both structurally (getBillability zeroes 'missed' exactly as it zeroed
// a past 'scheduled') and explicitly: after flagging, this cron flips the lesson
// 'scheduled' -> 'missed' (status only; never hours/billing/student), so a settled
// forfeit stops masquerading as a still-'scheduled' class.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const now = new Date()
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000)

  // ── NEW258: self-healing repair sweep ─────────────────────────────────────
  // A killed booking request can commit a 'scheduled' lesson but never write its
  // paired 'pending' report (the booking routes write it as a separate
  // non-blocking call). Such a lesson is invisible to the reports-driven query
  // below and stays 'scheduled' forever, counted at full projected pay. A live
  // AFTER INSERT trigger (NEW258) now closes the gap at source; this sweep
  // repairs any pre-trigger orphans so they become flaggable — once the report
  // exists, the normal flow below flags it on the next run (its deadline is
  // already past). Bounded to 50 per run. Any failure here is logged and
  // swallowed so it never aborts the flagging pass that follows.
  // Fetch candidates oldest-first and cap the candidate scan, but apply the
  // per-run repair budget to the ORPHANS (below), not to this raw fetch. Most
  // past-'scheduled' rows already have a report — grace-window lessons, and
  // 'reopened' reports whose lesson stays 'scheduled' forever (the flagging pass
  // never flips 'reopened' to 'missed') — so a plain unordered LIMIT would let
  // that reported backlog crowd genuine orphans out of the window and silently
  // starve the exact rows this sweep exists to repair. Oldest-first drains the
  // most-overdue zombies, and hitting the candidate cap is logged so a growing
  // backlog is visible rather than silent.
  const CANDIDATE_LIMIT = 200
  const REPAIR_LIMIT = 50
  try {
    const { data: pastScheduled, error: sweepFetchErr } = await supabase
      .from('lessons')
      .select('id, teacher_id, scheduled_at, duration_minutes')
      .eq('status', 'scheduled')
      .lt('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(CANDIDATE_LIMIT)

    if (sweepFetchErr) {
      console.error('[NEW258] repair sweep: failed to fetch past scheduled lessons:', sweepFetchErr)
    } else if (pastScheduled && pastScheduled.length > 0) {
      if (pastScheduled.length === CANDIDATE_LIMIT) {
        console.warn(`[NEW258] repair sweep: candidate scan hit the ${CANDIDATE_LIMIT}-row cap; any orphans older than the scanned window wait for a later run`)
      }
      // No NOT EXISTS in the JS client: fetch report rows for these lesson ids
      // and filter the orphans in code.
      const lessonIds = pastScheduled.map((l) => l.id)
      const { data: existingReports, error: sweepReportsErr } = await supabase
        .from('reports')
        .select('lesson_id')
        .in('lesson_id', lessonIds)

      if (sweepReportsErr) {
        console.error('[NEW258] repair sweep: failed to fetch existing reports:', sweepReportsErr)
      } else {
        const hasReport = new Set((existingReports ?? []).map((r) => r.lesson_id))
        const orphans = pastScheduled.filter((l) => !hasReport.has(l.id)).slice(0, REPAIR_LIMIT)

        for (const lesson of orphans) {
          const classEndsAtIso = new Date(
            new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60 * 1000
          ).toISOString()
          const { error: repairErr } = await createPendingReport(
            supabase,
            lesson.id,
            lesson.teacher_id,
            classEndsAtIso
          )
          if (repairErr) {
            console.error(`[NEW258] repair sweep: failed to create pending report for lesson ${lesson.id}:`, repairErr)
          } else {
            console.log(`[NEW258] repair sweep: created missing pending report for lesson ${lesson.id}`)
          }
        }
      }
    }
  } catch (sweepErr) {
    console.error('[NEW258] repair sweep: unexpected error, continuing to flagging pass:', sweepErr)
  }

  // Coarse filter on the joined lesson's scheduled_at (start time);
  // exact start + duration + 12h check is per-row in JS.
  const { data: reports, error } = await supabase
    .from('reports')
    .select(`
      id,
      status,
      lesson_id,
      teacher_id,
      teacher:profiles!teacher_id ( full_name, email, timezone ),
      lessons!inner (
        id,
        scheduled_at,
        duration_minutes,
        report_overdue_sent,
        student:students!student_id ( full_name )
      )
    `)
    .in('status', ['pending', 'reopened'])
    .lte('lessons.scheduled_at', twelveHoursAgo.toISOString())

  if (error) {
    console.error('Error fetching overdue reports:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let flagged = 0

  for (const report of reports ?? []) {
    const lesson = Array.isArray(report.lessons) ? report.lessons[0] : report.lessons
    if (!lesson) continue

    // Idempotency: this lesson's report was already processed on an earlier run.
    if (lesson.report_overdue_sent === true) continue

    // Only 'pending' reports may be auto-flagged. 'reopened' reports were
    // deliberately re-opened by an admin and must never be re-flagged.
    if (report.status !== 'pending') continue

    // Exact deadline: class END (start + duration) + 12h. The coarse query
    // filtered on start time only, so re-check precisely here. Not yet overdue -> skip.
    const classEndMs = new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60 * 1000
    if (classEndMs + 12 * 60 * 60 * 1000 > now.getTime()) continue

    // ── Flag the report (the pay decision) ──────────────────────────────────
    // Conditional on status='pending' so a concurrent completion/reopen can't be
    // clobbered. .select() returns the affected rows; zero rows means the report
    // was completed or reopened between the read and this write -> skip it.
    const flaggedAt = new Date().toISOString()
    const { data: flaggedRows, error: flagErr } = await supabase
      .from('reports')
      .update({ status: 'flagged', flagged_at: flaggedAt, updated_at: flaggedAt })
      .eq('id', report.id)
      .eq('status', 'pending')
      .select('id')

    if (flagErr) {
      console.error(`Failed to flag report ${report.id} as overdue:`, flagErr)
      continue
    }
    if (!flaggedRows || flaggedRows.length === 0) {
      // Completed or reopened in the meantime — no flag, no email, no flag-sent write.
      continue
    }

    // The flag stands from here on, regardless of what happens with the email.
    flagged++

    // Settle the lesson: 'scheduled' -> 'missed'. The class happened but the
    // report window was blown, so the lesson is now a settled forfeit. STATUS
    // ONLY: must not touch hours_consumed, the student, or any billing field.
    // Guarded on status='scheduled' exactly like the report flag above;
    // .select('id') confirms the write. Zero rows => the lesson left 'scheduled'
    // in a race (e.g. it was just completed) -> log and carry on, never error.
    const { data: missedRows, error: missedErr } = await supabase
      .from('lessons')
      .update({ status: 'missed' })
      .eq('id', lesson.id)
      .eq('status', 'scheduled')
      .select('id')

    if (missedErr) {
      console.error(`Failed to flip lesson ${lesson.id} to 'missed':`, missedErr)
    } else if (!missedRows || missedRows.length === 0) {
      console.log(`Lesson ${lesson.id} no longer 'scheduled'; 'missed' flip skipped`)
    }

    // ── Notify the teacher that the reporting window was missed ──────────────
    // Best-effort only: the pay decision above must NOT depend on Resend being up,
    // so any email failure is logged and swallowed — the flag is never rolled back.
    const teacher = Array.isArray(report.teacher) ? report.teacher[0] : report.teacher
    const student = Array.isArray(lesson.student) ? lesson.student[0] : lesson.student
    try {
      if (teacher?.email) {
        // Fall back to UTC when the teacher has no timezone set, rather than
        // throwing — the email must still send.
        const teacherTz = teacher.timezone ?? 'UTC'
        const { error: emailErr } = await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacher.email,
          subject: 'Class report window missed',
          html: buildEmailTemplate({
            recipientName: teacher.full_name,
            recipientFallback: 'Teacher',
            subject: 'Class report window missed',
            bodyHtml: teacherReportForfeitedEmailContent(
              student?.full_name ?? 'your student',
              lesson.scheduled_at,
              teacherTz
            ),
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
        if (emailErr) {
          console.error(`Forfeiture email errored for report ${report.id}:`, emailErr)
        }
      } else {
        console.error(`No teacher email for report ${report.id}; flag stands, email skipped`)
      }
    } catch (err) {
      console.error(`Failed to send forfeiture email for report ${report.id}:`, err)
    }

    // ── Mark the lesson processed so it isn't revisited on later runs ─────────
    const { error: updErr } = await supabase
      .from('lessons')
      .update({ report_overdue_sent: true })
      .eq('id', lesson.id)

    if (updErr) {
      console.error(`Failed to set report_overdue_sent on lesson ${lesson.id}:`, updErr)
    }
  }

  return NextResponse.json({ ok: true, flagged })
}
