import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'

// This route is called by Vercel Cron daily.
// It finds lessons that ended more than 12 hours ago with no completed report,
// emails the teacher, and sets report_overdue_sent = true to prevent re-sends.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  // Conservative DB filter: lessons that started more than 12h ago.
  // The exact end-time check (start + duration + 12h < now) is done below per-lesson
  // because duration_minutes varies and can't be expressed in a single column filter.
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000)

  const { data: lessons, error } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      teacher_id,
      profiles:teacher_id ( full_name, email )
    `)
    .in('status', ['completed', 'no_show'])
    .or('report_overdue_sent.is.null,report_overdue_sent.eq.false')
    .lte('scheduled_at', twelveHoursAgo.toISOString())

  if (error) {
    console.error('Error fetching overdue report lessons:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let sent = 0

  for (const lesson of lessons ?? []) {
    const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles

    if (!teacher) continue

    // Exact deadline check: the 12h window starts when the class ends, not when it starts
    const classEndMs = new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60 * 1000
    if (classEndMs + 12 * 60 * 60 * 1000 > now.getTime()) continue

    // Skip if a completed report already exists for this lesson
    const { data: completedReport } = await supabase
      .from('reports')
      .select('id')
      .eq('lesson_id', lesson.id)
      .eq('status', 'completed')
      .maybeSingle()

    if (completedReport) continue

    try {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: 'Lingualink Online — Please complete your class report',
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          subject: 'Please complete your class report',
          bodyHtml: `
            <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
              The 12-hour deadline to submit your class report has now passed. Please log in to your portal and complete the report as soon as possible.
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
              Timely reports are important for tracking student progress. If you have any difficulties, please contact us and we will help you.
            </p>
            <a
              href="https://teachers.lingualinkonline.com/reports"
              style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
            >
              Complete My Report
            </a>
          `,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })

      await supabase
        .from('lessons')
        .update({ report_overdue_sent: true })
        .eq('id', lesson.id)

      sent++
    } catch (err) {
      console.error(`Failed to send report overdue email for lesson ${lesson.id}:`, err)
    }
  }

  return NextResponse.json({ ok: true, sent })
}
