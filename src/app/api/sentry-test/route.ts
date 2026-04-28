import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    throw new Error('Sentry test error - delete this route after confirming')
  } catch (error) {
    Sentry.captureException(error)
    return NextResponse.json({ error: 'Test error captured' }, { status: 500 })
  }
}
