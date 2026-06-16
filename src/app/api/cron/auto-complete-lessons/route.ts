import { NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'

// DISABLED (NEW178, S146). This cron previously promoted past 'scheduled'
// lessons to status='completed'. That was incorrect: 'completed' is a paid,
// billable status, and stamping it on classes with no submitted report caused
// teachers to be paid for classes that never happened ("no report = no pay"
// was bypassed at the data level).
//
// The lesson lifecycle is being corrected separately: a 'pending' report row
// will be created when a class is booked, a lesson will reach 'completed' ONLY
// via complete_report_atomic on report submission, and a future-dated cron will
// FLAG (not complete) unreported past classes so admin can withhold pay and
// chase the report. Until that lands, this endpoint intentionally does nothing
// to lesson status.
//
// The route is kept (not deleted) so the existing Vercel cron schedule keeps
// hitting a valid endpoint instead of 404-ing daily. It will be re-implemented
// or removed when the report lifecycle work ships.

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  // No-op by design. See header comment.
  return NextResponse.json({
    ok: true,
    disabled: true,
    reason: 'auto-complete disabled pending report-lifecycle fix (NEW178)',
  })
}
