import { NextResponse } from 'next/server'

export async function GET() {
  throw new Error('Sentry test error - delete this route after confirming')
  return NextResponse.json({ ok: true })
}
