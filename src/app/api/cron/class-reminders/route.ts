import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentClassReminderEmailContent,
  teacherClassReminderEmailContent,
} from '@/lib/email/templates'
import { verifyCronAuth } from '@/lib/cron-auth'
import { requireTz } from '@/lib/time/requireTz'

// This route is called by Vercel Cron every 15 minutes.
// It checks for lessons starting within the next 24 hours or 1 hour
// that haven't had their reminder emails sent yet, and sends them.

// We use the service role key here because this runs server-side
// outside of a user session — it needs to read across all records.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const now = new Date()

  // ── 24-hour reminders ──────────────────────────────────────────────────────
  // Find lessons starting between 23h and 25h from now that haven't been sent

  const window24hStart = new Date(now.getTime() + 23 * 60 * 60 * 1000)
  const window24hEnd   = new Date(now.getTime() + 25 * 60 * 60 * 1000)

  const { data: lessons24h, error: error24h } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      teams_join_url,
      teacher_id,
      student_id,
      profiles:teacher_id ( full_name, email, timezone ),
      students:student_id ( full_name, email, timezone )
    `)
    .eq('status', 'scheduled')
    .eq('reminder_24_sent', false)
    .gte('scheduled_at', window24hStart.toISOString())
    .lte('scheduled_at', window24hEnd.toISOString())

  if (error24h) {
    console.error('Error fetching 24h reminder lessons:', error24h)
  }

  for (const lesson of lessons24h ?? []) {
    const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles
    const student = Array.isArray(lesson.students) ? lesson.students[0] : lesson.students

    if (!teacher || !student) continue

    try {
      // Resolve both timezones FIRST. If either is null, requireTz throws and the
      // lesson is skipped entirely — no flag write, no email — so the next run
      // retries it cleanly.
      const studentTz = requireTz(student.timezone, 'cron:student')
      const teacherTz = requireTz(teacher.timezone, 'cron:teacher')

      // Claim the lesson BEFORE sending anything. The flag write runs first and is
      // verified (exactly one row must come back). The contract this gives us:
      //   • flag write fails or doesn't land → nothing is sent and the whole lesson
      //     is retried on the next run;
      //   • flag write lands → duplicate sends are impossible, because the next run
      //     no longer selects this lesson;
      //   • a send failure AFTER the flag write loses that one reminder. Accepted
      //     at-most-once behaviour: the portal still shows the class, and the other
      //     reminder window (1h) covers it.
      const { data: flagRow, error: flagErr } = await supabase
        .from('lessons')
        .update({ reminder_24_sent: true })
        .eq('id', lesson.id)
        // Test-and-set: an overlapping run matches 0 rows here and skips via the guard below.
        .eq('reminder_24_sent', false)
        .select('id')

      if (flagErr || flagRow?.length !== 1) {
        console.error(
          `Skipping 24h reminder for lesson ${lesson.id}: reminder_24_sent write did not land`,
          flagErr
        )
        continue
      }

      // Email to student
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online - Your class is in less than 24 hours',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class is in less than 24 hours',
          bodyHtml: studentClassReminderEmailContent(
            lesson.scheduled_at,
            lesson.duration_minutes,
            null,
            studentTz,
            24
          ),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })

      // Email to teacher
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: 'Lingualink Online - Your next class is in less than 24 hours',
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject: 'Your next class is in less than 24 hours',
          bodyHtml: teacherClassReminderEmailContent(
            student.full_name ?? 'your student',
            lesson.scheduled_at,
            lesson.duration_minutes,
            null,
            teacherTz,
            24
          ),
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })

    } catch (err) {
      console.error(`Failed to send 24h reminder for lesson ${lesson.id}:`, err)
      // Continue to next lesson — don't let one failure block the rest
    }
  }

  // ── 1-hour reminders ───────────────────────────────────────────────────────
  // Find lessons starting between 45 minutes and 75 minutes from now

  const window1hStart = new Date(now.getTime() + 45 * 60 * 1000)
  const window1hEnd   = new Date(now.getTime() + 75 * 60 * 1000)

  const { data: lessons1h, error: error1h } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      teams_join_url,
      teacher_id,
      student_id,
      profiles:teacher_id ( full_name, email, timezone ),
      students:student_id ( full_name, email, timezone )
    `)
    .eq('status', 'scheduled')
    .eq('reminder_1h_sent', false)
    .gte('scheduled_at', window1hStart.toISOString())
    .lte('scheduled_at', window1hEnd.toISOString())

  if (error1h) {
    console.error('Error fetching 1h reminder lessons:', error1h)
  }

  for (const lesson of lessons1h ?? []) {
    const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles
    const student = Array.isArray(lesson.students) ? lesson.students[0] : lesson.students

    if (!teacher || !student) continue

    try {
      // Resolve both timezones FIRST. If either is null, requireTz throws and the
      // lesson is skipped entirely — no flag write, no email — so the next run
      // retries it cleanly.
      const studentTz = requireTz(student.timezone, 'cron:student')
      const teacherTz = requireTz(teacher.timezone, 'cron:teacher')

      // Claim the lesson BEFORE sending anything. The flag write runs first and is
      // verified (exactly one row must come back). The contract this gives us:
      //   • flag write fails or doesn't land → nothing is sent and the whole lesson
      //     is retried on the next run;
      //   • flag write lands → duplicate sends are impossible, because the next run
      //     no longer selects this lesson;
      //   • a send failure AFTER the flag write loses that one reminder. Accepted
      //     at-most-once behaviour: the portal still shows the class, and the 24h
      //     reminder has already gone out.
      const { data: flagRow, error: flagErr } = await supabase
        .from('lessons')
        .update({ reminder_1h_sent: true })
        .eq('id', lesson.id)
        // Test-and-set: an overlapping run matches 0 rows here and skips via the guard below.
        .eq('reminder_1h_sent', false)
        .select('id')

      if (flagErr || flagRow?.length !== 1) {
        console.error(
          `Skipping 1h reminder for lesson ${lesson.id}: reminder_1h_sent write did not land`,
          flagErr
        )
        continue
      }

      // Email to student
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online - Your class is in less than one hour',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class is in less than one hour',
          bodyHtml: studentClassReminderEmailContent(
            lesson.scheduled_at,
            lesson.duration_minutes,
            lesson.teams_join_url,
            studentTz,
            1
          ),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })

      // Email to teacher
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: 'Lingualink Online - Your next class is in less than one hour',
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject: 'Your next class is in less than one hour',
          bodyHtml: teacherClassReminderEmailContent(
            student.full_name ?? 'your student',
            lesson.scheduled_at,
            lesson.duration_minutes,
            lesson.teams_join_url,
            teacherTz,
            1
          ),
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })

    } catch (err) {
      console.error(`Failed to send 1h reminder for lesson ${lesson.id}:`, err)
    }
  }

  return NextResponse.json({
    ok: true,
    sent24h: lessons24h?.length ?? 0,
    sent1h: lessons1h?.length ?? 0,
  })
}
