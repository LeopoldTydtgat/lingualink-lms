import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/sentry-scrub'

const isProduction = process.env.NODE_ENV === 'production'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: isProduction ? 0.1 : 1.0,
  beforeSend(event) {
    scrubEvent(event as unknown as Record<string, unknown>)
    return event
  },
})
