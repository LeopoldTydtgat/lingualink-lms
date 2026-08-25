import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Lost-insert-response net for POST /api/admin/classes.
 *
 * The unit tests in verifyLessonCommitted.test.ts pin the verifier itself. What
 * they cannot see is whether this route WIRES it correctly, and that wiring is
 * the whole money path: between book_class_atomic_keyed and the lessons insert
 * route holds hours it must either give back or keep, and it decides which by
 * the verdict. Every test below therefore drives the REAL verifier - it is
 * deliberately not mocked - by scripting only what the lessons read-back
 * returns, and asserts on the three things the route can get wrong:
 *
 *   - refund_hours_atomic dispatched (or NOT) against a row that may be live;
 *   - cancelTeamsMeeting dispatched (or NOT) against what may be the student's
 *     live join link;
 *   - the status code, because a 409/500 invites a retry and BookingFlowClient
 *     leaves Confirm enabled with the selection intact - a second real class.
 *
 * The proven-rollback case is the regression test for the common path: a 23P01
 * must still skip the read-back entirely and behave byte-for-byte as it did
 * before the verifier existed.
 */

// -- Recorded call shape -----------------------------------------------------
// Every query the fake service-role client sees is reduced to this record, and
// the tests decide what a query MEANS from its filters rather than from its
// position in a queue: the route issues three separate lessons.select calls
// (teacher clash, student clash, verifier read-back) and a positional script
// would break the moment their order or their filters changed.
type Scripted = { data: unknown; error: unknown } | { reject: unknown }

type QueryCall = {
  table: string
  columns: string
  eqs: Array<[string, unknown]>
  iss: Array<[string, unknown]>
  gtes: Array<[string, unknown]>
  lts: Array<[string, unknown]>
  nots: Array<[string, string, unknown]>
  limits: number[]
  terminal: 'single' | 'maybeSingle' | null
  insertValues: Record<string, unknown> | null
  updateValues: Record<string, unknown> | null
}

const store = vi.hoisted(() => ({
  froms: [] as string[],
  // Only awaited queries land here. A builder that was constructed and never
  // resolved is not a query, and the 23P01 test turns on that distinction.
  lessonsSelectCalls: [] as QueryCall[],
  lessonInsertCalls: [] as QueryCall[],
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Scripted>,
  lessonInsert: { data: null, error: null } as Scripted,
  lessonsSelect: (() => ({ data: [], error: null })) as (call: QueryCall) => Scripted,
  teacherProfile: null as unknown,
  teacherProfileError: null as unknown,
  teacherEmailProfile: null as unknown,
  studentRow: null as unknown,
  training: null as unknown,
  trainingError: null as unknown,
  teamsMeeting: { joinUrl: '', meetingId: '' },
  teamsFails: false,
  adminClientCount: 0,
}))

// -- Fake service-role client ------------------------------------------------
// A chainable builder that RECORDS table, select, every filter, insert, update
// and rpc, and resolves to a scripted result. `then` honours both callbacks, so
// a query can REJECT mid-flight - the lost-response shape - rather than only
// throwing synchronously. Recording is the point: several tests below prove a
// query did not happen at all.
vi.mock('@/lib/supabase/admin', () => {
  const KNOWN_TABLES = ['profiles', 'students', 'lessons', 'hours_log']

  function resolveScripted(call: QueryCall): Scripted {
    if (call.table === 'profiles') {
      // The eligibility read selects `status`; the email read does not.
      return call.columns.includes('status')
        ? { data: store.teacherProfile, error: store.teacherProfileError }
        : { data: store.teacherEmailProfile, error: null }
    }
    if (call.table === 'students') return { data: store.studentRow, error: null }
    if (call.table === 'hours_log') return { data: null, error: null }
    if (call.table === 'lessons') {
      if (call.insertValues !== null) {
        store.lessonInsertCalls.push(call)
        return store.lessonInsert
      }
      store.lessonsSelectCalls.push(call)
      return store.lessonsSelect(call)
    }
    return { data: null, error: null }
  }

  function makeClient() {
    store.adminClientCount += 1
    return {
      from(table: string) {
        store.froms.push(table)
        if (!KNOWN_TABLES.includes(table)) {
          throw new Error(`unexpected table in test: ${table}`)
        }
        const call: QueryCall = {
          table,
          columns: '',
          eqs: [],
          iss: [],
          gtes: [],
          lts: [],
          nots: [],
          limits: [],
          terminal: null,
          insertValues: null,
          updateValues: null,
        }
        const builder = {
          select(columns: string) {
            call.columns = columns
            return builder
          },
          eq(column: string, value: unknown) {
            call.eqs.push([column, value])
            return builder
          },
          is(column: string, value: unknown) {
            call.iss.push([column, value])
            return builder
          },
          gte(column: string, value: unknown) {
            call.gtes.push([column, value])
            return builder
          },
          lt(column: string, value: unknown) {
            call.lts.push([column, value])
            return builder
          },
          not(column: string, operator: string, value: unknown) {
            call.nots.push([column, operator, value])
            return builder
          },
          limit(count: number) {
            call.limits.push(count)
            return builder
          },
          maybeSingle() {
            call.terminal = 'maybeSingle'
            return builder
          },
          single() {
            call.terminal = 'single'
            return builder
          },
          insert(values: Record<string, unknown>) {
            call.insertValues = values
            return builder
          },
          update(values: Record<string, unknown>) {
            call.updateValues = values
            store.updates.push({ table, values })
            return builder
          },
          then(
            resolve: (r: { data: unknown; error: unknown }) => void,
            reject?: (e: unknown) => void,
          ) {
            const scripted = resolveScripted(call)
            if ('reject' in scripted) {
              reject?.(scripted.reject)
              return
            }
            resolve({ data: scripted.data, error: scripted.error })
          },
        }
        return builder
      },
      rpc(fn: string, args: unknown) {
        store.rpcs.push({ fn, args })
        const scripted = store.rpcResults[fn] ?? { data: null, error: null }
        if ('reject' in scripted) return Promise.reject(scripted.reject)
        return Promise.resolve({ data: scripted.data, error: scripted.error })
      },
    }
  }

  return { createAdminClient: () => makeClient() }
})

// The anon/SSR client: the auth check and the trainings ownership+balance read.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-admin-1' } }, error: null }),
    },
    from(table: string) {
      if (table !== 'trainings') throw new Error(`unexpected table in test: ${table}`)
      const builder = {
        select() {
          return builder
        },
        eq() {
          return builder
        },
        maybeSingle: async () => ({ data: store.training, error: store.trainingError }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/auth/requireStaff', () => ({
  requireStaff: vi.fn(async () => ({ id: 'auth-admin-1' })),
}))

vi.mock('@/lib/microsoft/graph', () => ({
  createTeamsMeeting: vi.fn(async () => {
    if (store.teamsFails) throw new Error('Graph 503 - meeting not created')
    return store.teamsMeeting
  }),
  cancelTeamsMeeting: vi.fn(async () => undefined),
}))

// Must be mocked: the Resend constructor runs at module scope in
// @/lib/email/client and throws on a missing API key.
vi.mock('@/lib/email/client', () => ({
  default: { emails: { send: vi.fn(async () => ({ data: null, error: null })) } },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined) }))

vi.mock('@/lib/google/lessonEvents', () => ({
  createLessonGoogleEvent: vi.fn(async () => undefined),
}))

vi.mock('@/lib/reports/createPendingReport', () => ({
  createPendingReport: vi.fn(async () => ({ error: null })),
}))

vi.mock('@/lib/admin/raiseReconciliationTask', () => ({
  raiseReconciliationTask: vi.fn(async () => undefined),
}))

// @/lib/lessons/verifyLessonCommitted is deliberately NOT mocked - the point of
// this file is that the route drives the real helper. @/lib/email/templates is
// left real too: it has no module-level side effects (its env reads are inside
// the content functions and LOGO_URL is a literal).

// Imported AFTER the mocks are registered.
import { POST } from './route'
import { cancelTeamsMeeting, createTeamsMeeting } from '@/lib/microsoft/graph'
import { raiseReconciliationTask } from '@/lib/admin/raiseReconciliationTask'
import { localToUtc } from '@/lib/utils/timezone'
import { NextRequest } from 'next/server'

// -- Fixtures ----------------------------------------------------------------
const TEACHER_ID = '11111111-1111-4111-8111-111111111111'
const STUDENT_ID = '22222222-2222-4222-8222-222222222222'
const TRAINING_ID = '33333333-3333-4333-8333-333333333333'
const TEACHER_TZ = 'Europe/Brussels'
const STUDENT_TZ = 'Asia/Tokyo'
// Far future so the route's past-booking guard can never fire with the clock.
const SCHEDULED_AT_LOCAL = '2030-01-15T10:00'
const DURATION_MINUTES = 60
const HOURS_REQUESTED = 1
const TEAMS_MEETING_ID = 'graph-meeting-admin-1'
// The exact value the insert writes to scheduled_at, derived through the real
// localToUtc rather than hardcoded, so DST can never make this test lie.
const SCHEDULED_AT_UTC = localToUtc(SCHEDULED_AT_LOCAL, TEACHER_TZ)

const BODY = {
  teacher_id: TEACHER_ID,
  student_id: STUDENT_ID,
  training_id: TRAINING_ID,
  scheduled_at: SCHEDULED_AT_LOCAL,
  duration_minutes: DURATION_MINUTES,
}

function makeRequest(body: unknown = BODY): NextRequest {
  return new NextRequest('http://localhost/api/admin/classes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// A clash check is the only lessons query carrying an `lt` on scheduled_at;
// neither verifier mode does. Keyed on the filter, not on call order.
function isClashCheck(call: QueryCall): boolean {
  return call.lts.some(([column]) => column === 'scheduled_at')
}

function verifierCalls(): QueryCall[] {
  return store.lessonsSelectCalls.filter((call) => !isClashCheck(call))
}

function refundCalls(): Array<{ fn: string; args: unknown }> {
  return store.rpcs.filter((r) => r.fn === 'refund_hours_atomic')
}

function taskCalls() {
  return vi.mocked(raiseReconciliationTask).mock.calls
}

// Scripts the verifier read-back only; the two clash checks always come back
// empty so the booking reaches the insert.
function scriptVerifier(handler: (call: QueryCall) => Scripted): void {
  store.lessonsSelect = (call) => (isClashCheck(call) ? { data: [], error: null } : handler(call))
}

let errorSpy: { mockRestore: () => void }
let logSpy: { mockRestore: () => void }

beforeEach(() => {
  vi.clearAllMocks()

  store.froms = []
  store.lessonsSelectCalls = []
  store.lessonInsertCalls = []
  store.updates = []
  store.rpcs = []
  store.rpcResults = {
    book_class_atomic_keyed: { data: { log_id: 'hours-log-1', replayed: false, lesson_id: null }, error: null },
    refund_hours_atomic: { data: { success: true }, error: null },
  }
  store.lessonInsert = { data: null, error: null }
  store.lessonsSelect = () => ({ data: [], error: null })
  store.teacherProfile = { timezone: TEACHER_TZ, status: 'current', account_types: ['teacher'] }
  store.teacherProfileError = null
  store.teacherEmailProfile = {
    full_name: 'Teacher One',
    email: 'teacher@example.com',
    timezone: TEACHER_TZ,
  }
  store.studentRow = {
    full_name: 'Student One',
    email: 'student@example.com',
    timezone: STUDENT_TZ,
  }
  store.training = {
    id: TRAINING_ID,
    student_id: STUDENT_ID,
    total_hours: 10,
    hours_consumed: 0,
    status: 'active',
  }
  store.trainingError = null
  store.teamsMeeting = {
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
    meetingId: TEAMS_MEETING_ID,
  }
  store.teamsFails = false
  store.adminClientCount = 0

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  // Restored individually rather than through vi.restoreAllMocks() so the
  // implementations set in the vi.mock factories above survive the file.
  errorSpy.mockRestore()
  logSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// A proven rollback must not pay for a read
// ---------------------------------------------------------------------------

describe('POST /api/admin/classes - a proven rollback still short-circuits', () => {
  it('23P01 slot conflict: no read-back at all, refund dispatched, 409', async () => {
    store.lessonInsert = {
      data: null,
      error: {
        code: '23P01',
        message: 'conflicting key value violates exclusion constraint "no_teacher_overlap"',
        details: null,
      },
    }

    const res = await POST(makeRequest())

    // isRollbackProven is true, so the route must not issue the read-back.
    expect(verifierCalls()).toHaveLength(0)
    expect(store.lessonsSelectCalls).toHaveLength(2)
    expect(store.lessonsSelectCalls.every(isClashCheck)).toBe(true)

    expect(refundCalls()).toHaveLength(1)
    expect(refundCalls()[0].args).toEqual({
      p_training_id: TRAINING_ID,
      p_hours: HOURS_REQUESTED,
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'SLOT_NOT_AVAILABLE',
      message: 'This slot is no longer available - it was just booked by another student.',
    })
  })
})

// ---------------------------------------------------------------------------
// The insert RETURNS an unproven error
// ---------------------------------------------------------------------------

describe('POST /api/admin/classes - an unproven insert error is resolved by reading back', () => {
  it('committed (mode A finds this request meeting id): no refund, no Teams cancel, 201', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier((call) => {
      // Mode A: the row is identified by the meeting the fake Graph call minted.
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      return { data: [{ id: 'lesson-committed-1' }], error: null }
    })

    const res = await POST(makeRequest())

    expect(verifierCalls()).toHaveLength(1)
    // The class exists: reversing the hours would cancel a live class, and the
    // meeting is now that class's join link.
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-1')

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ lesson_id: 'lesson-committed-1' })
  })

  it('unresolved (the read-back itself errors): no refund, no Teams cancel, 500', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: null, error: { message: 'connection reset', code: 'PGRST301' } }))

    const res = await POST(makeRequest())

    expect(verifierCalls()).toHaveLength(1)
    // Neither state is proven and the dangerous half is a committed row, so
    // nothing is written and a human decides.
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('not_committed (zero rows): the refund is genuinely owed and IS dispatched', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest())

    expect(verifierCalls()).toHaveLength(1)
    expect(refundCalls()).toHaveLength(1)
    expect(refundCalls()[0].args).toEqual({
      p_training_id: TRAINING_ID,
      p_hours: HOURS_REQUESTED,
    })
    // No row points at the meeting, so the orphan is cancelled as before.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    // The refund landed, so nothing is owed to a human.
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(500)
  })

  it('mode B with ONE natural-key row is unresolved, NOT committed: no refund, no Teams cancel, 500', async () => {
    // Graph failed, so there is no per-request id on the row. A single
    // natural-key match could be a concurrent duplicate submission; claiming it
    // would skip a refund that is owed and double-deduct the student.
    store.teamsFails = true
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    let modeBCall: QueryCall | null = null
    scriptVerifier((call) => {
      modeBCall = call
      return { data: [{ id: 'somebody-elses-lesson' }], error: null }
    })

    const res = await POST(makeRequest())

    expect(vi.mocked(createTeamsMeeting)).toHaveBeenCalled()
    expect(verifierCalls()).toHaveLength(1)
    const call = modeBCall as unknown as QueryCall
    expect(call.iss).toEqual([['teams_meeting_id', null]])
    expect(call.eqs).toEqual([
      ['teacher_id', TEACHER_ID],
      ['student_id', STUDENT_ID],
      ['training_id', TRAINING_ID],
      ['scheduled_at', SCHEDULED_AT_UTC],
      ['duration_minutes', DURATION_MINUTES],
    ])

    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })
})

// ---------------------------------------------------------------------------
// book_class_atomic_keyed answers, but not in its contracted shape
// ---------------------------------------------------------------------------
//
// These three sit one step EARLIER than every test above: the RPC does not
// error, so the deductError fall-through never runs, but its jsonb payload
// cannot be trusted to say whether the hours moved. All three assert the same
// things, because they are the ways this path could lose a student money:
//
//   - no lessons insert, so nothing is booked on top of an unknown deduction;
//   - no refund_hours_atomic, because refund_hours_atomic has no "was never
//     deducted" guard and pendingRefund must never have been armed;
//   - 500, never a 409 - a 409 asserts the hours are safe, and here nothing
//     proves that.
//
// The gates return before the Teams call, so no meeting is ever minted and
// there is nothing to orphan. A reconciliation task is what makes these paths
// visible to a human, so its presence and the hours it names are asserted too.

describe('POST /api/admin/classes - a malformed or replayed deduction payload holds the booking', () => {
  it('replayed: true holds - no lessons insert, no refund, 500', async () => {
    // lesson_id null is the trap this test exists for. The NEW257 backfill is
    // best-effort, so a null stored lesson id does NOT prove no lesson exists -
    // reading it as "nothing was booked" and refunding would credit hours that
    // may be paying for a live class.
    store.rpcResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-replay-1', replayed: true, lesson_id: null },
      error: null,
    }

    const res = await POST(makeRequest())

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    expect(store.rpcs.map((r) => r.fn)).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('data null with error null holds - no lessons insert, no refund, 500', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: null }

    const res = await POST(makeRequest())

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    expect(store.rpcs.map((r) => r.fn)).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('a payload with no log_id holds - no lessons insert, no refund, 500', async () => {
    // replayed: false reads as a fresh deduction, so only the missing log_id
    // stands between this payload and a booking with an unlinkable ledger row.
    store.rpcResults.book_class_atomic_keyed = {
      data: { replayed: false, lesson_id: null },
      error: null,
    }

    const res = await POST(makeRequest())

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    expect(store.rpcs.map((r) => r.fn)).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })
})

// ---------------------------------------------------------------------------
// The insert REJECTS, so the outer catch owns the verdict
// ---------------------------------------------------------------------------

describe('POST /api/admin/classes - a throw AT the insert is resolved in the outer catch', () => {
  it('committed: no refund, no Teams cancel, 201 with the verified row id', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier((call) => {
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      return { data: [{ id: 'lesson-committed-2' }], error: null }
    })

    const res = await POST(makeRequest())

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-2')

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ lesson_id: 'lesson-committed-2' })
  })

  it('unresolved: no refund, no Teams cancel, 500', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: null, error: { message: 'statement timeout', code: '57014' } }))

    const res = await POST(makeRequest())

    expect(verifierCalls()).toHaveLength(1)
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
  })

  it('not_committed: the refund is owed and IS dispatched, through a fresh client, 500', async () => {
    // Both halves are needed to reach the refund block from the outer catch:
    // the insert must REJECT (so no insert-handler verdict runs) and the
    // read-back must then prove no row exists.
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest())

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)

    // The specific behaviour this test exists to reach: the route's own
    // adminClient is scoped to the try and may never have been constructed, so
    // both the read-back and the refund below build their own.
    expect(store.adminClientCount).toBeGreaterThan(1)

    expect(refundCalls()).toHaveLength(1)
    expect(refundCalls()[0].args).toEqual({
      p_training_id: TRAINING_ID,
      p_hours: HOURS_REQUESTED,
    })

    // No row points at the meeting, so the orphan is cancelled.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    // The refund landed, so nothing is owed to a human.
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
  })
})
