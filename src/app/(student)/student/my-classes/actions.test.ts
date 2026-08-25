import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cancel-path idempotency wiring for the student cancel action.
 *
 * The student path is the one place a cancellation is conditionally refunded by
 * the CLOCK rather than by an admin toggle: >=24h refunds, inside 24h does not.
 * That makes the same-key retry doubly load-bearing - a second execution would
 * not only cancel twice, it would credit a refund the student was not owed.
 *
 * Every test below pins the NUMBER of cancel_lesson_atomic_keyed calls and, on
 * the retried paths, that the second call is byte-identical to the first.
 */

type Scripted = { data: unknown; error: unknown } | { reject: unknown }

const store = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Scripted>,
  rpcRetryResults: {} as Record<string, Scripted>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  studentRow: null as unknown,
  studentError: null as unknown,
  lessonRow: null as unknown,
  lessonError: null as unknown,
  teacherProfile: null as unknown,
}))

// Service-role client: the teacher profile read, the cancel RPC, the
// teams_meeting_id null-out.
vi.mock('@/lib/supabase/admin', () => {
  const KNOWN_TABLES = ['profiles', 'lessons']

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
          maybeSingle: async () =>
            table === 'profiles'
              ? { data: store.teacherProfile, error: null }
              : { data: null, error: null },
          single: async () =>
            table === 'profiles'
              ? { data: store.teacherProfile, error: null }
              : { data: null, error: null },
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

  return { createAdminClient: () => makeClient() }
})

// Anon/SSR client: auth, the students ownership read, and the lessons
// ownership read. Both are .maybeSingle() and both are gates.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-student-1' } }, error: null }),
    },
    from(table: string) {
      if (table !== 'students' && table !== 'lessons') {
        throw new Error(`unexpected table in test: ${table}`)
      }
      const builder = {
        select() {
          return builder
        },
        eq() {
          return builder
        },
        maybeSingle: async () =>
          table === 'students'
            ? { data: store.studentRow, error: store.studentError }
            : { data: store.lessonRow, error: store.lessonError },
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/microsoft/graph', () => ({
  cancelTeamsMeeting: vi.fn(async () => undefined),
}))

vi.mock('@/lib/google/lessonEvents', () => ({
  deleteLessonGoogleEvent: vi.fn(async () => undefined),
}))

// Must be mocked: the Resend constructor runs at module scope and throws on a
// missing API key.
vi.mock('@/lib/email/client', () => ({
  default: { emails: { send: vi.fn(async () => ({ data: null, error: null })) } },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined) }))

// Imported AFTER the mocks are registered.
import { cancelLessonAction } from './actions'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import resend from '@/lib/email/client'

const LESSON_ID = '44444444-4444-4444-8444-444444444444'
const TEACHER_ID = '11111111-1111-4111-8111-111111111111'
const STUDENT_PK = '22222222-2222-4222-8222-222222222222'
const TRAINING_ID = '33333333-3333-4333-8333-333333333333'
const TEAMS_MEETING_ID = 'graph-meeting-student-cancel-1'

const HOUR_MS = 60 * 60 * 1000

// The refund side of the RPC call is decided by the clock, so the fixture's
// scheduled_at is built RELATIVE to now rather than hardcoded - a fixed date
// would silently flip the expected p_should_refund as it aged.
function scheduledInHours(hours: number): string {
  return new Date(Date.now() + hours * HOUR_MS).toISOString()
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
  store.studentRow = {
    id: STUDENT_PK,
    full_name: 'Student One',
    email: 'student@example.com',
    timezone: 'Asia/Tokyo',
  }
  store.studentError = null
  store.lessonRow = {
    id: LESSON_ID,
    student_id: STUDENT_PK,
    training_id: TRAINING_ID,
    teacher_id: TEACHER_ID,
    scheduled_at: scheduledInHours(48),
    duration_minutes: 60,
    status: 'scheduled',
    teams_meeting_id: TEAMS_MEETING_ID,
  }
  store.lessonError = null
  store.teacherProfile = {
    full_name: 'Teacher One',
    email: 'teacher@example.com',
    timezone: 'Europe/Brussels',
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

describe('student cancel - the clean path', () => {
  it('calls the keyed RPC exactly once, carrying a key and the clock-derived refund flag', async () => {
    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(1)
    const args = cancelArgs()[0]
    expect(typeof args.p_idempotency_key).toBe('string')
    expect(args.p_lesson_id).toBe(LESSON_ID)
    expect(args.p_cancelled_by).toBe('student')
    // 48h out, so the refund is owed.
    expect(args.p_should_refund).toBe(true)

    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(vi.mocked(deleteLessonGoogleEvent)).toHaveBeenCalledWith(LESSON_ID)

    expect(result).toEqual({ success: true, refunded: true })
  })

  it('inside 24 hours the RPC is asked NOT to refund', async () => {
    store.lessonRow = { ...(store.lessonRow as object), scheduled_at: scheduledInHours(3) }
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: false, refunded: false, remaining_hours: 8 },
      error: null,
    }

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(1)
    expect(cancelArgs()[0].p_should_refund).toBe(false)
    expect(result).toEqual({ success: true, refunded: false })
  })
})

// ---------------------------------------------------------------------------
// A lost round trip is settled by ONE same-key retry
// ---------------------------------------------------------------------------

describe('student cancel - a lost response is settled by a same-key retry', () => {
  it('retry REPLAYS (the first call had committed): one cancellation and one refund stand', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: true, refunded: true, remaining_hours: 9 },
      error: null,
    }

    const result = await cancelLessonAction(LESSON_ID)

    // Two calls, and the second must be byte-identical - a fresh key would
    // refund the student twice for one cancellation.
    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])

    expect(result).toEqual({ success: true, refunded: true })
  })

  it('retry does NOT replay (the first call never committed): the retry performs it', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: false, refunded: true, remaining_hours: 9 },
      error: null,
    }

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])
    expect(result).toEqual({ success: true, refunded: true })
  })

  it('BOTH calls lose their response: nothing is torn down and no email goes out', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: null,
      error: { message: 'socket hang up again' },
    }

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])

    // The class may still be live. Tearing down the meeting or telling the
    // student it is cancelled would both act on a cancellation nobody can prove.
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteLessonGoogleEvent)).not.toHaveBeenCalled()
    expect(vi.mocked(resend.emails.send)).not.toHaveBeenCalled()
    expect(store.updates).toHaveLength(0)

    expect(
      vi.mocked(console.error).mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('CRITICAL'),
      ),
    ).toHaveLength(1)

    expect(result).toEqual({
      success: false,
      error: 'We could not confirm whether this class was cancelled. Refresh the page to check before trying again.',
    })
  })
})

// ---------------------------------------------------------------------------
// A structured failure is an ANSWER, and answers are never retried
// ---------------------------------------------------------------------------

describe('student cancel - a structured failure is not retried', () => {
  it('LESSON_NOT_CANCELLABLE on the first call: exactly ONE call', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_CANCELLABLE' },
      error: null,
    }

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(1)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      error: 'This lesson can no longer be cancelled. Please refresh and try again.',
      code: 'LESSON_NOT_CANCELLABLE',
    })
  })

  it('LESSON_NOT_FOUND on the first call: exactly ONE call', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_FOUND' },
      error: null,
    }

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(1)
    expect(result).toEqual({ success: false, error: 'Lesson not found' })
  })
})

// ---------------------------------------------------------------------------
// The ownership gates run BEFORE any key is minted
// ---------------------------------------------------------------------------
//
// A read that could not complete must never reach the money path at all: the
// RPC is the thing that moves hours, so "we could not verify this is yours" has
// to stop short of it rather than fail somewhere inside it.

describe('student cancel - a failed ownership read never reaches the RPC', () => {
  it('the students read errors: no RPC call at all', async () => {
    store.studentError = { message: 'connection reset' }
    store.studentRow = null

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(0)
    expect(result).toEqual({
      success: false,
      error: 'Could not verify your account. Please try again.',
    })
  })

  it('the lessons read errors: no RPC call at all', async () => {
    store.lessonError = { message: 'connection reset' }
    store.lessonRow = null

    const result = await cancelLessonAction(LESSON_ID)

    expect(cancelCalls()).toHaveLength(0)
    expect(result).toEqual({
      success: false,
      error: 'Could not load this class. Please try again.',
    })
  })
})
