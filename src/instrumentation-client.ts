import * as Sentry from '@sentry/nextjs'
import { feedbackIntegration } from '@sentry/nextjs'
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
  // Client bundle: Next.js only inlines NEXT_PUBLIC_-prefixed vars into browser
  // code, so the DSN must come from NEXT_PUBLIC_SENTRY_DSN. This is the public
  // ingest DSN and is safe to expose in the bundle (see M-15 above).
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: isProduction ? 0.1 : 1.0,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 0.0,
  integrations: [
    // Synchronous feedback integration: fully bundled, so it never fetches from
    // a CDN and the CSP needs no widget-specific allowance. autoInject is off —
    // this file loads on EVERY portal (admin and login included) and the only
    // entry points are the explicit "Report a problem" buttons that call
    // attachTo() from the teacher and student navs.
    feedbackIntegration({
      autoInject: false,
      enableScreenshot: true,
      showBranding: false,
      colorScheme: 'light',
      themeLight: { accentBackground: '#FF8303', accentForeground: '#ffffff' },
      formTitle: 'Report a problem',
      submitButtonLabel: 'Send report',
      messagePlaceholder: 'What went wrong? Tell us what you were doing when it happened.',
      successMessageText: 'Thank you. Your report has been sent.',
    }),
  ],
  beforeSend(event) {
    scrubEvent(event as unknown as Record<string, unknown>)
    return event
  },
})

// The beforeSend above does NOT run on feedback events: core gates
// processBeforeSend on isErrorEvent, so a feedback envelope bypasses it
// entirely and the user's typed message would reach Sentry unscrubbed.
// beforeSendFeedback is the only hook on that path. scrubEvent mutates in
// place and already walks `contexts`, which is where the feedback message,
// name and contact_email live.
const client = Sentry.getClient()
client?.on('beforeSendFeedback', (event) => {
  scrubEvent(event as unknown as Record<string, unknown>)
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
