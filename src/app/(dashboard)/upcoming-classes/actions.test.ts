import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cancel-path idempotency wiring for the teacher cancel action.
 *
 * This path ALWAYS refunds - a teacher cancellation is never the student's
 * fault - so the same-key retry is the only thing standing between a lost
 * response and a second refund on a class that was already cancelled once.
 *
 * Every test below pins the NUMBER of cancel_lesson_atomic_keyed calls and, on
 * the retried paths, that the second call is byte-identical to the first.
 */

type Scripted = { data: unknown; error: unknown } | { reject: unknown }

const store = vi.hoisted(() => ({
  // Lives in the hoisted store so the vi.mock factory below can read it: a
  // module-scope const would not be initialised when the factory runs.
  teacherAuthId: '11111111-1111-4111-8111-111111111111',
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Scripted>,
  rpcRetryResults: {} as Record<string, Scripted>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  lessonRow: null as unknown,
  lessonError: null as unknown,
  teacherProfile: null as unknown,
  teacherProfileError: null as unknown,
  studentRow: null as unknown,
}))

// Service-role client: the teacher profile read, the student read, the cancel
// RPC, and the teams_meeting_id null-out. Both reads are .single().
vi.mock('@/lib/supabase/admin', () => {
  const KNOWN_TABLES = ['profiles', 'students', 'lessons']

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
    if (table === 'profiles') {
      return { data: store.teacherProfile, error: store.teacherProfileError }
    }
    if (table === 'students') return { data: store.studentRow, error: null }
    return { data: null, error: null }
  }

  return { createAdminClient: () => makeClient() }
})

// Anon/SSR client: auth and the teacher-scoped lessons ownership read.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: store.teacherAuthId } }, error: null }),
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
        maybeSingle: async () => ({ data: store.lessonRow, error: store.lessonError }),
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

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(() => undefined) }))

// Imported AFTER the mocks are registered.
import { teacherCancelLesson } from './actions'
import { cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import resend from '@/lib/email/client'

const LESSON_ID = '44444444-4444-4444-8444-444444444444'
const STUDENT_PK = '22222222-2222-4222-8222-222222222222'
const TRAINING_ID = '33333333-3333-4333-8333-333333333333'
const TEAMS_MEETING_ID = 'graph-meeting-teacher-cancel-1'
const MESSAGE = 'Sorry, I am unwell and cannot teach this class.'

const HOUR_MS = 60 * 60 * 1000

// The 24-hour gate is evaluated against the wall clock, so the fixture is built
// RELATIVE to now - a hardcoded date would age into the blocked branch.
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
  store.lessonRow = {
    id: LESSON_ID,
    teacher_id: store.teacherAuthId,
    student_id: STUDENT_PK,
    training_id: TRAINING_ID,
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
  store.teacherProfileError = null
  store.studentRow = {
    id: STUDENT_PK,
    full_name: 'Student One',
    email: 'student@example.com',
    timezone: 'Asia/Tokyo',
    auth_user_id: '55555555-5555-4555-8555-555555555555',
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

describe('teacher cancel - the clean path', () => {
  it('calls the keyed RPC exactly once, carrying a key and an unconditional refund', async () => {
    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    expect(cancelCalls()).toHaveLength(1)
    const args = cancelArgs()[0]
    expect(typeof args.p_idempotency_key).toBe('string')
    expect(args.p_lesson_id).toBe(LESSON_ID)
    expect(args.p_cancelled_by).toBe('teacher')
    // A teacher cancellation is never the student's fault, so the refund is
    // not conditional on anything.
    expect(args.p_should_refund).toBe(true)
    expect(args.p_cancellation_reason).toBe(MESSAGE)

    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(vi.mocked(deleteLessonGoogleEvent)).toHaveBeenCalledWith(LESSON_ID)

    expect(result).toEqual({ success: true, refunded: true })
  })
})

// ---------------------------------------------------------------------------
// A lost round trip is settled by ONE same-key retry
// ---------------------------------------------------------------------------

describe('teacher cancel - a lost response is settled by a same-key retry', () => {
  it('retry REPLAYS (the first call had committed): one cancellation and one refund stand', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.cancel_lesson_atomic_keyed = {
      data: { success: true, replayed: true, refunded: true, remaining_hours: 9 },
      error: null,
    }

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    // Two calls, and the second must be byte-identical - a fresh key would
    // refund the student a second time for one cancellation.
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

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

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

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    expect(cancelCalls()).toHaveLength(2)
    expect(cancelArgs()[1]).toEqual(cancelArgs()[0])

    // The class may still be live. Tearing down the meeting or telling the
    // student it is off would both act on a cancellation nobody can prove.
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteLessonGoogleEvent)).not.toHaveBeenCalled()
    expect(vi.mocked(resend.emails.send)).not.toHaveBeenCalled()
    expect(store.updates).toHaveLength(0)

    expect(
      vi.mocked(console.error).mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('CRITICAL'),
      ),
    ).toHaveLength(1)

    expect(result).toEqual({ success: false, error: 'Failed to cancel lesson' })
  })
})

// ---------------------------------------------------------------------------
// A structured failure is an ANSWER, and answers are never retried
// ---------------------------------------------------------------------------

describe('teacher cancel - a structured failure is not retried', () => {
  it('LESSON_NOT_CANCELLABLE on the first call: exactly ONE call', async () => {
    store.rpcResults.cancel_lesson_atomic_keyed = {
      data: { success: false, code: 'LESSON_NOT_CANCELLABLE' },
      error: null,
    }

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

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

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    expect(cancelCalls()).toHaveLength(1)
    expect(result).toEqual({ success: false, error: 'Lesson not found' })
  })
})

// ---------------------------------------------------------------------------
// The gates run BEFORE any key is minted
// ---------------------------------------------------------------------------
//
// The RPC is what moves hours, so every refusal has to land short of it rather
// than somewhere inside it.

describe('teacher cancel - the gates never reach the RPC', () => {
  it('inside 24 hours: blocked, no RPC call at all', async () => {
    store.lessonRow = { ...(store.lessonRow as object), scheduled_at: scheduledInHours(3) }

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    expect(cancelCalls()).toHaveLength(0)
    expect(result).toEqual({
      success: false,
      error: 'You cannot cancel within 24 hours of the class. Please contact admin.',
    })
  })

  it('the lesson is not this teacher\'s: no RPC call at all', async () => {
    store.lessonRow = null

    const result = await teacherCancelLesson(LESSON_ID, MESSAGE)

    expect(cancelCalls()).toHaveLength(0)
    expect(result).toEqual({ success: false, error: 'Lesson not found' })
  })
})
