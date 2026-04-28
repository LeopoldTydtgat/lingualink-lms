import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

export async function GET() {
  console.log('SENTRY_DSN present:', !!process.env.SENTRY_DSN)
  console.log('SENTRY_DSN prefix:', process.env.SENTRY_DSN?.substring(0, 20))
  try {
    throw new Error('Sentry test error - delete this route after confirming')
  } catch (error) {
    Sentry.captureException(error)
    return NextResponse.json({
      error: 'Test error captured',
      dsnPresent: !!process.env.SENTRY_DSN
    }, { status: 500 })
  }
}
