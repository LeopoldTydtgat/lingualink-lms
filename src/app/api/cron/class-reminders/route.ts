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
      // Resolve both timezones BEFORE sending anything. If either is null, skip the
      // whole lesson (no email sent, reminder flag NOT set) so the next run retries
      // cleanly. Prevents the student email firing then the teacher email throwing,
      // which would re-send the student reminder every run.
      const studentTz = requireTz(student.timezone, 'cron:student')
      const teacherTz = requireTz(teacher.timezone, 'cron:teacher')

      // Email to student
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online — Your class is in less than 24 hours',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class is in less than 24 hours',
          bodyHtml: studentClassReminderEmailContent(
            teacher.full_name ?? 'your teacher',
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
        subject: 'Lingualink Online — Your next class is in less than 24 hours',
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

      // Mark as sent so we don't send it again
      await supabase
        .from('lessons')
        .update({ reminder_24_sent: true })
        .eq('id', lesson.id)

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
      // Resolve both timezones BEFORE sending anything. If either is null, skip the
      // whole lesson (no email sent, reminder flag NOT set) so the next run retries
      // cleanly. Prevents the student email firing then the teacher email throwing,
      // which would re-send the student reminder every run.
      const studentTz = requireTz(student.timezone, 'cron:student')
      const teacherTz = requireTz(teacher.timezone, 'cron:teacher')

      // Email to student
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online — Your class is in less than one hour',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your class is in less than one hour',
          bodyHtml: studentClassReminderEmailContent(
            teacher.full_name ?? 'your teacher',
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
        subject: 'Lingualink Online — Your next class is in less than one hour',
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

      // Mark as sent
      await supabase
        .from('lessons')
        .update({ reminder_1h_sent: true })
        .eq('id', lesson.id)

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
