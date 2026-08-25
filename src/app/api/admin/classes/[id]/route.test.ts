import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cancel-path idempotency wiring for PATCH /api/admin/classes/[id].
 *
 * cancel_lesson_atomic_keyed is the money path here: on the refund-on branch a
 * second execution would credit a second refund. The route's protection is a
 * per-request key plus exactly ONE same-key retry, and this file pins the three
 * things that wiring can get wrong:
 *
 *   - retrying when the database ALREADY answered (a structured
 *     { success: false } is not ambiguous and must never be probed);
 *   - retrying with a FRESH key, which would cancel/refund a second time
 *     instead of asking whether the first call landed;
 *   - continuing past a double failure, where neither call is known to have
 *     committed and the teardown must not run.
 *
 * The refund toggle is asserted on BOTH calls, because a retry that disagreed
 * with the first call about p_should_refund would be a different transaction
 * wearing the same key.
 */

type Scripted = { data: unknown; error: unknown } | { reject: unknown }

const store = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Scripted>,
  rpcRetryResults: {} as Record<string, Scripted>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  existingLesson: null as unknown,
  existingLessonError: null as unknown,
  teacherProfile: null as unknown,
  studentRow: null as unknown,
}))

// Service-role client: the cancel RPC, the teams_meeting_id null-out, and the
// two participant reads that feed the emails.
vi.mock('@/lib/supabase/admin', () => {
  const KNOWN_TABLES = ['lessons', 'profiles', 'students']

  function makeClient() {
    return {
      from(table: string) {
        if (!KNOWN_TABLES.includes(table)) {
          throw new Error(`unexpected table in test: ${table}`)
        }
        const builder = {
          select() {
            return builder
          },
          eq() {
            return builder
          },
          update(values: Record<string, unknown>) {
            store.updates.push({ table, values })
            return builder
          },
          single: async () => resolveRead(table),
          maybeSingle: async () => resolveRead(table),
          then(resolve: (r: { data: unknown; error: unknown }) => void) {
            resolve({ data: null, error: null })
          },
        }
        return builder
      },
      rpc(fn: string, args: unknown) {
        // Read BEFORE recording, so the first call to a name is never mistaken
        // for its own retry.
        const isRetry = store.rpcs.some((r) => r.fn === fn)
        store.rpcs.push({ fn, args })
        const scripted =
          (isRetry ? store.rpcRetryResults[fn] : undefined) ??
          store.rpcResults[fn] ?? { data: null, error: null }
        if ('reject' in scripted) return Promise.reject(scripted.reject)
        return Promise.resolve({ data: scripted.data, error: scripted.error })
      },
    }
  }

  function resolveRead(table: string): { data: unknown; error: unknown } {
    if (table === 'profiles') return { data: store.teacherProfile, error: null }
    if (table === 'students') return { data: store.studentRow, error: null }
    return { data: null, error: null }
  }

  return { createAdminClient: () => makeClient() }
})

// Anon/SSR client: the auth check and the pre-cancel lessons read.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-admin-1' } }, error: null }),
    },
    from(table: string) {
      if (table !== 'lessons') throw new Error(`unexpected table in test: ${table}`)
      const builder = {
        select() {
          return builder
        },
        eq() {
          return builder
        },
        single: async () => ({ data: store.existingLesson, error: store.existingLessonError }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/auth/requireStaff', () => ({
  requireStaff: vi.fn(async () => ({ id: 'auth-admin-1' })),
}))

vi.mock('@/lib/microsoft/graph', () => ({
  cancelTeamsMeeting: vi.fn(async () => undefined),
  createTeamsMeeting: vi.fn(async () => ({ joinUrl: '', meetingId: '' })),
  updateTeamsMeeting: vi.fn(async () => undefined),
}))

vi.mock('@/lib/google/lessonEvents', () => ({
  deleteLessonGoogleEvent: vi.fn(async () => undefined),
  updateLessonGoogleEvent: vi.fn(async () => undefined),
}))

// Must be mocked: the Resend constructor runs at module scope and throws on a
// missing API key.
vi.mock('@/lib/email/client', () => ({
  default: { emails: { send: vi.fn(async () => ({ data: null, error: null })) } },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined) }))

vi.mock('@/lib/billing/recomputeAmounts', () => ({
  recomputeInvoiceAmountsForTeacher: vi.fn(async () => undefined),
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(() => undefined) }))

// Imported AFTER the mocks are registered.
import { PATCH } from './route'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import resend from '@/lib/email/client'
import { NextRequest } from 'next/server'

const LESSON_ID = '44444444-4444-4444-8444-444444444444'
const TEACHER_ID = '11111111-1111-4111-8111-111111111111'
const STUDENT_ID = '22222222-2222-4222-8222-222222222222'
const TRAINING_ID = '33333333-3333-4333-8333-333333333333'
const TEAMS_MEETING_ID = 'graph-meeting-cancel-1'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/classes/${LESSON_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function cancelBody(refundHours: boolean) {
  return {
    action: 'cancel',
    cancellation_reason: 'Teacher unwell',
    refund_hours: refundHours,
  }
}

function callPatch(body: unknown) {
  return PATCH(makeRequest(body), { params: Promise.resolve({ id: LESSON_ID }) })
}

function cancelCalls(): Array<{ fn: string; args: unknown }> {
  return store.rpcs.filter((r) => r.fn === 'cancel_lesson_atomic_keyed')
}

function cancelArgs(): Array<Record<string, unknown>> {
  return cancelCalls().map((r) => r.args) as Array<Record<string, unknown>>
}

let errorSpy: { mockRestore: () => void }

beforeEach(() => {
  vi.clearAllMocks()

  store.rpcs = []
  store.rpcResults = {
    cancel_lesson_atomic_keyed: {
      data: { success: true, replayed: false, refunded: true, remaining_hours: 9 },
      error: null,
    },
  }
  store.rpcRetryResults = {}
  store.updates = []
  store.existingLesson = {
    id: LESSON_ID,
    teacher_id: TEACHER_ID,
    student_id: STUDENT_ID,
    training_id: TRAINING_ID,
    scheduled_at: '2030-01-15T09:00:00.000Z',
    duration_minutes: 60,
    status: 'scheduled',
    teams_meeting_id: TEAMS_MEETING_ID,
  }
  store.existingLessonError = null
  store.teacherProfile = {
    full_name: 'Teacher One',
    email: 'teacher@example.com',
    timezone: 'Europe/Brussels',
  }
  store.studentRow = {
    full_name: 'Student One',
    email: 'student@example.com',
    timezone: 'Asia/Tokyo',
  }

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  // Restored individually rather than through vi.restoreAllMocks() so the
  // implementations set in the vi.mock factories above survive the file.
  errorSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// The clean path mints a key and calls exactly once
// ---------------------------------------------------------------------------

describe('PATCH cancel - the clean path', () => {
  it('calls the keyed RPC exactly once, carrying a key and the admin toggle', async () => {
    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(1)
    const args = cancelArgs()[0]
    expect(typeof args.p_idempotency_key).toBe('string')
    expect(args.p_lesson_id).toBe(LESSON_ID)
    expect(args.p_cancelled_by).toBe('admin')
    expect(args.p_should_refund).toBe(true)

    // Teardown runs only once the cancellation is durably committed.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(vi.mocked(deleteLessonGoogleEvent)).toHaveBeenCalledWith(LESSON_ID)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('passes the refund toggle through unchanged when the admin turns it off', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: false, refunded: false, remaining_hours: 8 },
      error: null,
    }

    const res = await callPatch(cancelBody(false))

    expect(cancelCalls()).toHaveLength(1)
    expect(cancelArgs()[0].p_should_refund).toBe(false)
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// A lost round trip is settled by ONE same-key retry
// ---------------------------------------------------------------------------
//
// An rpcError means the response leg died, so the cancellation may or may not
// have committed. The retry carries the SAME key, which makes both outcomes
// safe: a replay names the cancellation the first call already made, and a
// non-replay performs the one the first call never did. Either way exactly one
// cancellation and at most one refund stand.

describe('PATCH cancel - a lost response is settled by a same-key retry', () => {
  it('retry REPLAYS (the first call had committed): one cancellation stands, 200', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: true, refunded: true, remaining_hours: 9 },
      error: null,
    }

    const res = await callPatch(cancelBody(true))

    // Exactly two calls, and the second must be byte-identical to the first. A
    // freshly minted key would refund a second time instead of answering the
    // question the first call left open.
    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])

    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(vi.mocked(deleteLessonGoogleEvent)).toHaveBeenCalledWith(LESSON_ID)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('retry does NOT replay (the first call never committed): the retry performs it, 200', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: false, refunded: true, remaining_hours: 9 },
      error: null,
    }

    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])
    expect(res.status).toBe(200)
  })

  it('a DIFFERENT actor cancelled in between: the stored key is theirs, so the retry refuses, 409', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_CANCELLABLE' },
      error: null,
    }

    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(2)
    // A real failure stays a failure - the retry must not launder someone
    // else's cancellation into a success for this request.
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteLessonGoogleEvent)).not.toHaveBeenCalled()

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'This lesson can no longer be cancelled. Please refresh and try again.',
      code: 'LESSON_NOT_CANCELLABLE',
    })
  })

  it('BOTH calls lose their response: nothing is torn down and no email goes out, 500', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: null,
      error: { message: 'socket hang up again' },
    }

    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])

    // The lesson may still be live. Deleting its Teams meeting or its calendar
    // block, or telling the student it is off, would all be acting on a
    // cancellation nobody can prove happened.
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteLessonGoogleEvent)).not.toHaveBeenCalled()
    expect(vi.mocked(resend.emails.send)).not.toHaveBeenCalled()
    expect(store.updates).toHaveLength(0)

    expect(
      vi.mocked(console.error).mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('CRITICAL'),
      ),
    ).toHaveLength(1)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'We could not confirm whether this class was cancelled. Refresh the page to check before trying again.',
    })
  })
})

// ---------------------------------------------------------------------------
// A structured failure is an ANSWER, and answers are never retried
// ---------------------------------------------------------------------------
//
// { success: false } means the database replied. There is nothing ambiguous to
// probe, and a second call would be a second attempt at work that was already
// refused - so the count is the assertion in both tests below.

describe('PATCH cancel - a structured failure is not retried', () => {
  it('LESSON_NOT_CANCELLABLE on the first call: exactly ONE call, 409', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_CANCELLABLE' },
      error: null,
    }

    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(1)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(res.status).toBe(409)
  })

  it('LESSON_NOT_FOUND on the first call: exactly ONE call, 404', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_FOUND' },
      error: null,
    }

    const res = await callPatch(cancelBody(true))

    expect(cancelCalls()).toHaveLength(1)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Lesson not found' })
  })
})
