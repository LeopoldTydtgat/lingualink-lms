import { NextResponse } from 'next/server'

// Shared guard for cron + keep-alive routes.
// Returns null when the caller is authorised, otherwise a NextResponse
// the route should return immediately.
//
// Fail-closed if CRON_SECRET is missing or implausibly short — without this
// guard, an undefined env var collapses the comparison to literal
// "Bearer undefined", which any caller can replay.
export function verifyCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 }
    )
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}
