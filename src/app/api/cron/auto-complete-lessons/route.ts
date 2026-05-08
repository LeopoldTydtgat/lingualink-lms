import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyCronAuth } from '@/lib/cron-auth'

// Daily cron. Promotes scheduled lessons whose
// scheduled_at + duration_minutes < now() to status='completed'.
// This is the placeholder status — report submission later overwrites
// to 'student_no_show' / 'teacher_no_show' via complete_report_atomic.
//
// No email side effects. Cancelled lessons are excluded by the
// status='scheduled' filter.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const now = new Date()
  const runDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`

  // Idempotency guard — Vercel Cron retries on timeout would otherwise
  // double-flip the same rows (the per-row eq('status','scheduled') guard
  // already covers correctness, but the run-row keeps an audit trail).
  const { data: runRows, error: runErr } = await supabase
    .from('cron_runs')
    .upsert(
      { cron_name: 'auto-complete-lessons', run_date: runDate },
      { onConflict: 'cron_name,run_date', ignoreDuplicates: true }
    )
    .select()

  if (runErr) {
    console.error('cron_runs guard failed:', runErr)
    return NextResponse.json({ error: 'Idempotency check failed' }, { status: 500 })
  }
  if (!runRows || runRows.length === 0) {
    return NextResponse.json({ ok: true, alreadyRanToday: true })
  }

  // Coarse SQL filter: status='scheduled' AND scheduled_at < now().
  // Exact end-time check (start + duration < now) happens in JS because
  // Postgres can't filter on scheduled_at + duration_minutes through the
  // Supabase JS client without a generated column or RPC.
  const { data: lessons, error } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes')
    .eq('status', 'scheduled')
    .lt('scheduled_at', now.toISOString())

  if (error) {
    console.error('Error fetching scheduled lessons:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let flipped = 0

  for (const lesson of lessons ?? []) {
    const endMs = new Date(lesson.scheduled_at).getTime() + lesson.duration_minutes * 60 * 1000
    if (endMs >= now.getTime()) continue

    const { error: updErr } = await supabase
      .from('lessons')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', lesson.id)
      .eq('status', 'scheduled')

    if (updErr) {
      console.error(`Failed to flip lesson ${lesson.id}:`, updErr)
      continue
    }

    flipped++
  }

  await supabase
    .from('cron_runs')
    .update({ completed_at: new Date().toISOString() })
    .eq('cron_name', 'auto-complete-lessons')
    .eq('run_date', runDate)

  return NextResponse.json({ ok: true, flipped })
}
