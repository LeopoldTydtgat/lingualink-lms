import { describe, it, expect } from 'vitest'
import { scrubEvent } from './sentry-scrub'

/**
 * NEW-A13 H5 regression net for the Sentry PII scrubber.
 *
 * The bug class: the scrubber only redacted by object KEY, so anything whose
 * key was innocuous sailed through untouched: `request.url` of
 * `/reset-password?token_hash=abc123` (a single-use password-reset token, live
 * for an hour) and any exception message that had a JWT interpolated into it.
 * Both land in Sentry, which is a third party outside our trust boundary.
 *
 * The scrubber now redacts on two axes, and these tests pin BOTH: the original
 * key-based redaction must keep working, and token-shaped string values must be
 * redacted in place while the surrounding path/message stays diagnosable.
 */

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

describe('scrubEvent: key redaction (pre-existing behaviour)', () => {
  it('redacts a top-level sensitive key under extra', () => {
    const out = scrubEvent({ extra: { password: 'hunter2' } })
    expect(out.extra.password).toBe('[Redacted]')
  })

  it('redacts a nested sensitive key under contexts and keeps its siblings', () => {
    const out = scrubEvent({
      contexts: {
        supabase: {
          session: { access_token: 'abc123', user_id: 'u-1', expires_in: 3600 },
        },
      },
    })
    expect(out.contexts.supabase.session.access_token).toBe('[Redacted]')
    expect(out.contexts.supabase.session.user_id).toBe('u-1')
    expect(out.contexts.supabase.session.expires_in).toBe(3600)
  })
})

describe('scrubEvent: string value redaction', () => {
  it('redacts a token_hash value in request.url but preserves the path and other params', () => {
    const out = scrubEvent({
      request: { url: 'https://students.lingualinkonline.com/reset-password?token_hash=abc123def&next=/dashboard' },
    })
    expect(out.request.url).toBe(
      'https://students.lingualinkonline.com/reset-password?token_hash=[Redacted]&next=/dashboard'
    )
  })

  it('redacts a JWT inside a breadcrumb message', () => {
    const out = scrubEvent({
      breadcrumbs: [{ category: 'auth', message: `refresh rejected for ${JWT} (401)` }],
    })
    expect(out.breadcrumbs[0].message).toBe('refresh rejected for [Redacted] (401)')
  })

  it('redacts a token_hash in exception.values[].value and leaves type/stacktrace alone', () => {
    const frames = [{ filename: 'src/app/reset-password/page.tsx', lineno: 42 }]
    const out = scrubEvent({
      exception: {
        values: [
          {
            type: 'AuthApiError',
            value: 'verifyOtp failed: GET /auth/v1/verify?token_hash=pkce_9f8e7d&type=recovery',
            stacktrace: { frames },
          },
        ],
      },
    })
    expect(out.exception.values[0].value).toBe(
      'verifyOtp failed: GET /auth/v1/verify?token_hash=[Redacted]&type=recovery'
    )
    expect(out.exception.values[0].type).toBe('AuthApiError')
    expect(out.exception.values[0].stacktrace.frames).toBe(frames)
  })

  it('redacts a JWT in the event message', () => {
    const out = scrubEvent({ message: `session decode failed: ${JWT}` })
    expect(out.message).toBe('session decode failed: [Redacted]')
  })

  it('redacts a bare token_hash in request.query_string (no leading ? or &)', () => {
    const out = scrubEvent({
      request: { query_string: 'token_hash=abc123&foo=bar' },
    })
    expect(out.request.query_string).toBe('token_hash=[Redacted]&foo=bar')
  })

  it('leaves a harmless string untouched', () => {
    const out = scrubEvent({
      message: 'Failed to fetch profile',
      request: { url: 'https://teachers.lingualinkonline.com/students?page=2' },
      extra: { note: 'Failed to fetch profile' },
    })
    expect(out.message).toBe('Failed to fetch profile')
    expect(out.request.url).toBe('https://teachers.lingualinkonline.com/students?page=2')
    expect(out.extra.note).toBe('Failed to fetch profile')
  })
})
