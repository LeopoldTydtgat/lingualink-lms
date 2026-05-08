import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyCronAuth } from '@/lib/cron-auth'

// Daily cron. Iterates reports that are still pending/reopened more than
// 12 hours after their lesson ended, and flips lessons.report_overdue_sent
// to true so the row is not re-flagged on subsequent runs.
//
// Iterates reports (not lessons) because once auto-complete-lessons runs,
// the linked lesson may already be 'completed' even though the teacher
// hasn't submitted a report — so a lessons-status filter would miss them.

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
      lessons!inner (
        id,
        scheduled_at,
        duration_minutes,
        report_overdue_sent
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

    if (lesson.report_overdue_sent === true) continue

    const classEndMs = new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60 * 1000
    if (classEndMs + 12 * 60 * 60 * 1000 > now.getTime()) continue

    const { error: updErr } = await supabase
      .from('lessons')
      .update({ report_overdue_sent: true })
      .eq('id', lesson.id)

    if (updErr) {
      console.error(`Failed to flag lesson ${lesson.id} as overdue:`, updErr)
      continue
    }

    flagged++
  }

  return NextResponse.json({ ok: true, flagged })
}
