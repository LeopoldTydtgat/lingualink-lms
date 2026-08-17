import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { verifyCronAuth } from '@/lib/cron-auth'

const adminSupabase = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  // Heartbeat: records that this cron FIRED (auth passed), not that it finished --
  // completed_at here is the fire time. cron_runs has UNIQUE (cron_name, run_date);
  // default upsert (ignoreDuplicates false) means sub-daily runs refresh completed_at
  // to the latest fire. Best-effort: a heartbeat failure must never abort the job.
  {
    const hbNow = new Date()
    const hbDate = `${hbNow.getUTCFullYear()}-${String(hbNow.getUTCMonth() + 1).padStart(2, '0')}-${String(hbNow.getUTCDate()).padStart(2, '0')}`
    const { error: hbErr } = await adminSupabase
      .from('cron_runs')
      .upsert(
        { cron_name: 'keep-alive', run_date: hbDate, completed_at: hbNow.toISOString() },
        { onConflict: 'cron_name,run_date' }
      )
    if (hbErr) console.error('[heartbeat] cron_runs write failed:', hbErr)
  }

  const { error } = await adminSupabase.from('profiles').select('id').limit(1)
  if (error) {
    console.error('[keep-alive] profiles select failed:', error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 200 })
}
