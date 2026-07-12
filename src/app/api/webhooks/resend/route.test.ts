import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'

// The Resend signing secret used for the whole suite. Any bytes work as the
// HMAC key; the route strips the `whsec_` prefix and base64-decodes the rest.
// Set inside vi.hoisted so the env vars exist BEFORE route.ts (and its
// email-client import, whose Resend constructor throws on a missing API key)
// are evaluated.
const SECRET = vi.hoisted(() => {
  const s = 'whsec_' + Buffer.from('new311-test-signing-key-abc123').toString('base64')
  process.env.RESEND_WEBHOOK_SECRET = s
  process.env.RESEND_API_KEY = 're_test_dummy_key'
  return s
})

// -- Fake service-role client ------------------------------------------------
// An in-memory two-table DB whose `ilike` faithfully simulates SQL ILIKE
// semantics (case-insensitive; `%`/`_` are wildcards, `\` escapes). That makes
// the case-insensitive-match test meaningful and would catch an unescaped-`_`
// wildcard bug in the route.
const store = vi.hoisted(() => ({
  db: {} as Record<string, Array<Record<string, unknown>>>,
}))

vi.mock('@/lib/supabase/admin', () => {
  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  function likeToRegex(pattern: string): RegExp {
    let re = '^'
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '\\') {
        re += escapeRe(pattern[++i] ?? '')
        continue
      }
      if (c === '%') { re += '.*'; continue }
      if (c === '_') { re += '.'; continue }
      re += escapeRe(c)
    }
    return new RegExp(re + '$', 'i')
  }
  type Row = Record<string, unknown>
  return {
    createAdminClient: () => ({
      // A thenable filter-builder: update() sets the mutation, ilike()/lt()
      // accumulate predicates, and awaiting it applies the mutation to every row
      // matching ALL predicates (mirrors PostgREST chained filters on an UPDATE).
      from(table: string) {
        let pending: Record<string, unknown> = {}
        const preds: Array<(row: Row) => boolean> = []
        const builder = {
          update(values: Record<string, unknown>) {
            pending = values
            return builder
          },
          ilike(column: string, pattern: string) {
            const rx = likeToRegex(pattern)
            preds.push((row: Row) => {
              const v = row[column]
              return typeof v === 'string' && rx.test(v)
            })
            return builder
          },
          lt(column: string, value: string) {
            preds.push((row: Row) => {
              const v = row[column]
              return typeof v === 'string' && v < value
            })
            return builder
          },
          then(resolve: (r: { data: null; error: null }) => void) {
            const rows = store.db[table] ?? []
            for (const row of rows) {
              if (preds.every((p) => p(row))) Object.assign(row, pending)
            }
            resolve({ data: null, error: null })
          },
        }
        return builder
      },
    }),
  }
})

// Import AFTER the mock is registered.
import { POST } from './route'

// -- Signing helper (documented Svix / Standard-Webhooks scheme) --------------
function sign(secret: string, id: string, tsSeconds: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signed = `${id}.${tsSeconds}.${body}`
  const sig = crypto.createHmac('sha256', key).update(signed).digest('base64')
  return `v1,${sig}`
}

function makeRequest(
  body: string,
  opts: {
    id?: string
    ts?: number
    signature?: string
    omitHeaders?: boolean
  } = {}
): Request {
  const id = opts.id ?? 'msg_test_1'
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (!opts.omitHeaders) {
    headers['svix-id'] = id
    headers['svix-timestamp'] = String(ts)
    headers['svix-signature'] = opts.signature ?? sign(SECRET, id, ts, body)
  }
  return new Request('http://localhost/api/webhooks/resend', {
    method: 'POST',
    headers,
    body,
  })
}

function bouncedPayload(to: string[]) {
  return JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-07-12T10:00:00.000Z',
    data: {
      created_at: '2026-07-12T10:00:00.000Z',
      email_id: 'e1',
      from: 'no-reply@lingualinkonline.com',
      to,
      subject: 'Welcome',
      bounce: {
        type: 'Permanent',
        subType: 'General',
        message: 'The email account that you tried to reach does not exist.',
      },
    },
  })
}

function transientBouncedPayload(to: string[]) {
  return JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-07-12T10:00:00.000Z',
    data: {
      created_at: '2026-07-12T10:00:00.000Z',
      email_id: 'e1',
      from: 'no-reply@lingualinkonline.com',
      to,
      subject: 'Welcome',
      bounce: {
        type: 'Transient',
        subType: 'MailboxFull',
        message: 'The recipient mailbox is full.',
      },
    },
  })
}

// `createdAt` overridable so a test can craft a delivered event that predates a
// stored bounce (out-of-order delivery).
function deliveredPayload(to: string[], createdAt = '2026-07-12T11:00:00.000Z') {
  return JSON.stringify({
    type: 'email.delivered',
    created_at: createdAt,
    data: {
      created_at: createdAt,
      email_id: 'e2',
      from: 'no-reply@lingualinkonline.com',
      to,
      subject: 'Welcome',
    },
  })
}

function unknownPayload() {
  return JSON.stringify({
    type: 'email.opened',
    created_at: '2026-07-12T12:00:00.000Z',
    data: { email_id: 'e3', from: 'x', to: ['teacher@example.com'], subject: 'y' },
  })
}

beforeEach(() => {
  store.db = {
    profiles: [
      { id: 't1', email: 'Teacher@Example.com', email_bounced_at: null, email_bounce_reason: null },
      { id: 't2', email: 'other_teacher@example.com', email_bounced_at: null, email_bounce_reason: null },
    ],
    students: [
      { id: 's1', email: 'student@example.com', email_bounced_at: null, email_bounce_reason: null },
    ],
  }
})

describe('POST /api/webhooks/resend', () => {
  it('flags both a matching teacher and a matching student on email.bounced', async () => {
    const res = await POST(makeRequest(bouncedPayload(['teacher@example.com'])))
    expect(res.status).toBe(200)

    const teacher = store.db.profiles.find((r) => r.id === 't1')!
    expect(teacher.email_bounced_at).toBe('2026-07-12T10:00:00.000Z')
    expect(teacher.email_bounce_reason).toBe(
      'Permanent / General: The email account that you tried to reach does not exist.'
    )

    // A bounce to the student's address flags the student row too.
    const res2 = await POST(makeRequest(bouncedPayload(['student@example.com'])))
    expect(res2.status).toBe(200)
    const student = store.db.students.find((r) => r.id === 's1')!
    expect(student.email_bounced_at).toBe('2026-07-12T10:00:00.000Z')
    expect(student.email_bounce_reason).toContain('Permanent')
  })

  it('matches addresses case-insensitively', async () => {
    // Stored as Teacher@Example.com; bounce reports TEACHER@EXAMPLE.COM.
    const res = await POST(makeRequest(bouncedPayload(['TEACHER@EXAMPLE.COM'])))
    expect(res.status).toBe(200)
    expect(store.db.profiles.find((r) => r.id === 't1')!.email_bounced_at).toBe(
      '2026-07-12T10:00:00.000Z'
    )
  })

  it('does not let the `_` in an email act as a wildcard', async () => {
    // other_teacher@example.com must NOT be matched by a bounce for
    // otherXteacher@example.com (would happen if `_` were left unescaped).
    const res = await POST(makeRequest(bouncedPayload(['otherXteacher@example.com'])))
    expect(res.status).toBe(200)
    expect(store.db.profiles.find((r) => r.id === 't2')!.email_bounced_at).toBeNull()
  })

  it('clears both columns on email.delivered', async () => {
    // Pre-flag the teacher.
    await POST(makeRequest(bouncedPayload(['teacher@example.com'])))
    expect(store.db.profiles.find((r) => r.id === 't1')!.email_bounced_at).not.toBeNull()

    const res = await POST(makeRequest(deliveredPayload(['teacher@example.com'])))
    expect(res.status).toBe(200)
    const teacher = store.db.profiles.find((r) => r.id === 't1')!
    expect(teacher.email_bounced_at).toBeNull()
    expect(teacher.email_bounce_reason).toBeNull()
  })

  it('does not flag on a transient (non-permanent) bounce', async () => {
    const res = await POST(makeRequest(transientBouncedPayload(['teacher@example.com'])))
    expect(res.status).toBe(200)
    const teacher = store.db.profiles.find((r) => r.id === 't1')!
    expect(teacher.email_bounced_at).toBeNull()
    expect(teacher.email_bounce_reason).toBeNull()
  })

  it('does not clear a newer bounce when a stale (older) delivered arrives', async () => {
    // Permanent bounce at 10:00 flags the teacher.
    await POST(makeRequest(bouncedPayload(['teacher@example.com'])))
    expect(store.db.profiles.find((r) => r.id === 't1')!.email_bounced_at).toBe(
      '2026-07-12T10:00:00.000Z'
    )
    // A delivered event dated 09:00 (before the bounce) must NOT clear it.
    const res = await POST(
      makeRequest(deliveredPayload(['teacher@example.com'], '2026-07-12T09:00:00.000Z'))
    )
    expect(res.status).toBe(200)
    const teacher = store.db.profiles.find((r) => r.id === 't1')!
    expect(teacher.email_bounced_at).toBe('2026-07-12T10:00:00.000Z')
    expect(teacher.email_bounce_reason).toContain('Permanent')
  })

  it('is idempotent for repeated deliveries of the same bounce event', async () => {
    await POST(makeRequest(bouncedPayload(['teacher@example.com'])))
    const first = { ...store.db.profiles.find((r) => r.id === 't1')! }
    await POST(makeRequest(bouncedPayload(['teacher@example.com'])))
    const second = store.db.profiles.find((r) => r.id === 't1')!
    expect(second.email_bounced_at).toBe(first.email_bounced_at)
    expect(second.email_bounce_reason).toBe(first.email_bounce_reason)
  })

  it('no-ops with 200 for an unknown recipient address', async () => {
    const res = await POST(makeRequest(bouncedPayload(['nobody@nowhere.com'])))
    expect(res.status).toBe(200)
    expect(store.db.profiles.every((r) => r.email_bounced_at === null)).toBe(true)
    expect(store.db.students.every((r) => r.email_bounced_at === null)).toBe(true)
  })

  it('returns 200 for a valid but unhandled event type', async () => {
    const res = await POST(makeRequest(unknownPayload()))
    expect(res.status).toBe(200)
    expect(store.db.profiles.every((r) => r.email_bounced_at === null)).toBe(true)
  })

  it('rejects a bad signature with 401', async () => {
    const body = bouncedPayload(['teacher@example.com'])
    const res = await POST(makeRequest(body, { signature: 'v1,deadbeefnotarealsignature' }))
    expect(res.status).toBe(401)
    expect(store.db.profiles.find((r) => r.id === 't1')!.email_bounced_at).toBeNull()
  })

  it('rejects a stale timestamp (older than 5 minutes) with 401', async () => {
    const body = bouncedPayload(['teacher@example.com'])
    const staleTs = Math.floor(Date.now() / 1000) - 400
    const res = await POST(makeRequest(body, { ts: staleTs }))
    expect(res.status).toBe(401)
    expect(store.db.profiles.find((r) => r.id === 't1')!.email_bounced_at).toBeNull()
  })

  it('returns 401 when signature headers are missing', async () => {
    const body = bouncedPayload(['teacher@example.com'])
    const res = await POST(makeRequest(body, { omitHeaders: true }))
    expect(res.status).toBe(401)
  })
})
