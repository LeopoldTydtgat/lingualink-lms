import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isTrustedOrigin } from './host'

/**
 * CSRF origin gate for mutating /api/* requests (src/proxy.ts).
 *
 * The bug class: the auth cookie is Domain=.lingualinkonline.com, so every
 * sibling subdomain gets it attached automatically. SameSite=Lax does not help
 * — same-site includes every *.lingualinkonline.com host — so a page on any
 * other subdomain could drive an authenticated POST/PUT/PATCH/DELETE against
 * the portals. isTrustedOrigin is the gate: same-host or one of the two portal
 * URLs passes, everything else with an Origin header is rejected.
 *
 * A MISSING Origin header must still pass — cron (CRON_SECRET), the Resend
 * webhook (HMAC) and calendar apps are non-browser clients that send none, and
 * a browser always attaches Origin to a cross-site mutating request, so absence
 * cannot be the CSRF vector.
 *
 * Hosts are compared WITH the port: the Origin and Host headers both carry it,
 * and localhost:3000 vs localhost:3001 are different origins.
 */

const TEACHER = 'https://teachers.lingualinkonline.com'
const STUDENT = 'https://students.lingualinkonline.com'

const savedEnv = {
  teacher: process.env.NEXT_PUBLIC_TEACHER_URL,
  student: process.env.NEXT_PUBLIC_STUDENT_URL,
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_TEACHER_URL = TEACHER
  process.env.NEXT_PUBLIC_STUDENT_URL = STUDENT
})

afterEach(() => {
  // Restore, including the "was undefined" case — a leaked value would make the
  // no-env-configured tests below pass vacuously.
  if (savedEnv.teacher === undefined) delete process.env.NEXT_PUBLIC_TEACHER_URL
  else process.env.NEXT_PUBLIC_TEACHER_URL = savedEnv.teacher
  if (savedEnv.student === undefined) delete process.env.NEXT_PUBLIC_STUDENT_URL
  else process.env.NEXT_PUBLIC_STUDENT_URL = savedEnv.student
})

describe('isTrustedOrigin — no Origin header', () => {
  it('allows a null Origin (cron, Resend webhook, calendar apps)', () => {
    expect(isTrustedOrigin(null, 'teachers.lingualinkonline.com')).toBe(true)
  })

  it('allows a null Origin even when the host header is absent', () => {
    expect(isTrustedOrigin(null, null)).toBe(true)
    expect(isTrustedOrigin(null, undefined)).toBe(true)
  })
})

describe('isTrustedOrigin — same host', () => {
  it('allows an Origin matching this request host', () => {
    expect(
      isTrustedOrigin('https://teachers.lingualinkonline.com', 'teachers.lingualinkonline.com')
    ).toBe(true)
  })

  it('allows a same-host Origin carrying a port (localhost dev)', () => {
    expect(isTrustedOrigin('http://localhost:3000', 'localhost:3000')).toBe(true)
  })

  it('rejects the same hostname on a different port', () => {
    // Different port = different origin; the env portal URLs carry no port
    // either, so nothing rescues this.
    expect(isTrustedOrigin('http://localhost:3001', 'localhost:3000')).toBe(false)
  })

  it('compares case-insensitively', () => {
    expect(
      isTrustedOrigin('https://TEACHERS.LinguaLinkOnline.com', 'Teachers.lingualinkonline.COM')
    ).toBe(true)
  })

  it('uses only the first entry of a comma-joined Host header', () => {
    expect(
      isTrustedOrigin(
        'https://teachers.lingualinkonline.com',
        'teachers.lingualinkonline.com, evil.example.com'
      )
    ).toBe(true)
    expect(
      isTrustedOrigin(
        'https://evil.example.com',
        'teachers.lingualinkonline.com, evil.example.com'
      )
    ).toBe(false)
  })
})

describe('isTrustedOrigin — portal URLs', () => {
  it('allows the teacher portal calling the student portal', () => {
    expect(isTrustedOrigin(TEACHER, 'students.lingualinkonline.com')).toBe(true)
  })

  it('allows the student portal calling the teacher portal', () => {
    expect(isTrustedOrigin(STUDENT, 'teachers.lingualinkonline.com')).toBe(true)
  })

  it('matches the portal env URL by host, ignoring its path', () => {
    process.env.NEXT_PUBLIC_TEACHER_URL = 'https://teachers.lingualinkonline.com/'
    expect(isTrustedOrigin(TEACHER, 'students.lingualinkonline.com')).toBe(true)
  })

  it('rejects a portal-host Origin when the env vars are unset', () => {
    delete process.env.NEXT_PUBLIC_TEACHER_URL
    delete process.env.NEXT_PUBLIC_STUDENT_URL
    expect(isTrustedOrigin(TEACHER, 'students.lingualinkonline.com')).toBe(false)
    // Same-host still passes without any env configured.
    expect(isTrustedOrigin(TEACHER, 'teachers.lingualinkonline.com')).toBe(true)
  })

  it('ignores a malformed env URL instead of throwing', () => {
    process.env.NEXT_PUBLIC_TEACHER_URL = 'not a url'
    expect(isTrustedOrigin(TEACHER, 'students.lingualinkonline.com')).toBe(false)
    // The other portal URL is still consulted.
    expect(isTrustedOrigin(STUDENT, 'teachers.lingualinkonline.com')).toBe(true)
  })
})

describe('isTrustedOrigin — rejected origins', () => {
  it('rejects a sibling lingualinkonline.com subdomain', () => {
    // The whole point of the gate: this host receives the shared auth cookie.
    expect(
      isTrustedOrigin('https://www.lingualinkonline.com', 'teachers.lingualinkonline.com')
    ).toBe(false)
    expect(
      isTrustedOrigin('https://marketing.lingualinkonline.com', 'students.lingualinkonline.com')
    ).toBe(false)
  })

  it('rejects the apex domain', () => {
    expect(
      isTrustedOrigin('https://lingualinkonline.com', 'teachers.lingualinkonline.com')
    ).toBe(false)
  })

  it('rejects an unrelated site', () => {
    expect(isTrustedOrigin('https://evil.example.com', 'teachers.lingualinkonline.com')).toBe(false)
  })

  it('rejects a suffix-confusion host', () => {
    // Not a subdomain — a different registrable domain that merely ends with
    // the portal host as a string.
    expect(
      isTrustedOrigin(
        'https://teachers.lingualinkonline.com.evil.example',
        'teachers.lingualinkonline.com'
      )
    ).toBe(false)
  })

  it('rejects the literal string "null" (sandboxed iframe / opaque origin)', () => {
    expect(isTrustedOrigin('null', 'teachers.lingualinkonline.com')).toBe(false)
  })

  it('rejects a malformed Origin', () => {
    expect(isTrustedOrigin('not a url', 'teachers.lingualinkonline.com')).toBe(false)
    expect(isTrustedOrigin('teachers.lingualinkonline.com', 'teachers.lingualinkonline.com')).toBe(
      false
    )
    expect(isTrustedOrigin('', 'teachers.lingualinkonline.com')).toBe(false)
  })

  it('rejects any Origin when the host header is missing and no portal matches', () => {
    expect(isTrustedOrigin('https://evil.example.com', null)).toBe(false)
  })

  it('rejects scheme-only origins whose URL host is empty', () => {
    expect(isTrustedOrigin('file:///etc/passwd', 'teachers.lingualinkonline.com')).toBe(false)
    expect(isTrustedOrigin('about:blank', 'teachers.lingualinkonline.com')).toBe(false)
  })
})
