import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate, teacherReportForfeitedEmailContent } from '@/lib/email/templates'
import { verifyCronAuth } from '@/lib/cron-auth'

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
// withheld structurally by the lesson never leaving 'scheduled'.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const now = new Date()
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000)

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
