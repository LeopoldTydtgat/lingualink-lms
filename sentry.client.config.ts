import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/sentry-scrub'

// SECURITY (M-15): SENTRY_DSN must be the public ingest DSN
// (https://<key>@<id>.ingest.sentry.io/<project>), NOT a project auth token.
// Auth tokens carry write access to the Sentry org and would be devastating
// if leaked into a client bundle. Verify this in the Sentry project settings
// before deploying.
//
// SECURITY (M-25): replaysSessionSampleRate=0 and no replay sampling on errors
// means Session Replay is effectively disabled here — the client does not
// upload screen recordings of arbitrary user input. If replay is ever enabled,
// reconfirm that input masking and PII scrubbing still cover sensitive fields.
const isProduction = process.env.NODE_ENV === 'production'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: isProduction ? 0.1 : 1.0,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 0.0,
  beforeSend(event) {
    scrubEvent(event as unknown as Record<string, unknown>)
    return event
  },
})
