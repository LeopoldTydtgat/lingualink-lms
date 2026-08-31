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

// GET's lessons list query, reduced to the parts these tests judge it by. Separate
// from QueryCall above rather than folded into it: that record describes the
// service-role client POST drives, and GET never touches the service-role client at
// all - the two handlers share no query path, so they share no record shape.
type ListQuery = {
  columns: string
  filters: Array<[string, string, unknown]>
  orders: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>
  ranges: Array<[number, number]>
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
  // Scripted result for the SECOND and every later call to a named RPC. The one
  // path that calls the same RPC twice inside a single request is the
  // ambiguous-deduction probe below the fresh deduction, and the whole question
  // there is whether the second answer differs from the first - which a single
  // scripted value per RPC name cannot express. Left empty by default, so an RPC
  // with no retry script answers from rpcResults on every call exactly as before
  // and no existing test changes.
  rpcRetryResults: {} as Record<string, Scripted>,
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
  // -- GET harness -----------------------------------------------------------
  // The calling admin's own profile row, read by GET for its date-filter edges.
  adminProfile: null as unknown,
  // What the lessons list query resolves to, and the exact count beside it.
  lessonsList: [] as unknown[],
  lessonsListCount: 0 as number | null,
  // Every lessons list query that actually RESOLVED, in issue order.
  lessonsListQueries: [] as ListQuery[],
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
        // Read BEFORE this call is recorded, so the first call to a name is
        // never mistaken for its own retry.
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

// The anon/SSR client. POST drives it for the auth check and the trainings
// ownership+balance read; GET drives it for everything it does, because the GET handler
// never constructs a service-role client at all.
//
// The trainings branch below is byte-identical to the one the POST tests have always
// driven. The two branches beside it are purely additive and unreachable from POST,
// which reads neither profiles nor lessons through this client - so no existing test
// changes behaviour.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-admin-1' } }, error: null }),
    },
    from(table: string) {
      if (table === 'trainings') {
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
      }

      // GET's admin-timezone read. Only the date-filter edges consult the value, and
      // the sort tests send no date params, so this exists to keep the handler running
      // rather than to be asserted on.
      if (table === 'profiles') {
        const builder = {
          select() {
            return builder
          },
          eq() {
            return builder
          },
          maybeSingle: async () => ({ data: store.adminProfile, error: null }),
        }
        return builder
      }

      // GET's list query. It records the .order() calls in the order they were issued,
      // which is the whole point of this harness: .order() is the only place a ?sort=
      // value can reach the database, so asserting on the recorded { column, ascending }
      // pairs is what proves the raw string never got there itself.
      //
      // Recorded on RESOLVE, not on construction - the same discipline as the
      // service-role fake above. A builder that was never awaited is not a query, and
      // the rejected-sort test turns on that distinction.
      if (table === 'lessons') {
        const query: ListQuery = { columns: '', filters: [], orders: [], ranges: [] }
        const builder = {
          select(columns: string) {
            query.columns = columns
            return builder
          },
          eq(column: string, value: unknown) {
            query.filters.push(['eq', column, value])
            return builder
          },
          in(column: string, value: unknown) {
            query.filters.push(['in', column, value])
            return builder
          },
          or(expression: string) {
            query.filters.push(['or', expression, null])
            return builder
          },
          gte(column: string, value: unknown) {
            query.filters.push(['gte', column, value])
            return builder
          },
          lt(column: string, value: unknown) {
            query.filters.push(['lt', column, value])
            return builder
          },
          lte(column: string, value: unknown) {
            query.filters.push(['lte', column, value])
            return builder
          },
          order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
            query.orders.push({
              column,
              ascending: options.ascending,
              nullsFirst: options.nullsFirst,
            })
            return builder
          },
          range(from: number, to: number) {
            query.ranges.push([from, to])
            return builder
          },
          then(resolve: (r: { data: unknown; error: unknown; count: number | null }) => void) {
            store.lessonsListQueries.push(query)
            resolve({ data: store.lessonsList, error: null, count: store.lessonsListCount })
          },
        }
        return builder
      }

      throw new Error(`unexpected table in test: ${table}`)
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
import { GET, POST } from './route'
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

// GET takes everything from the URL, so a request IS its query string. `query` is the
// raw string without the leading '?'; '' means no params at all, which is the "no
// ?sort=" case.
function makeGetRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/admin/classes${query ? `?${query}` : ''}`)
}

// The single lessons list query a successful GET issues. Asserts the count rather than
// indexing blindly, so a test that expected a query and got none fails saying so.
function listQuery(): ListQuery {
  expect(store.lessonsListQueries).toHaveLength(1)
  return store.lessonsListQueries[0]
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

// The deduction RPC. The probe tests turn on how MANY times it was called and on
// what the second call carried, so both the count and the args are asserted.
function deductCalls(): Array<{ fn: string; args: unknown }> {
  return store.rpcs.filter((r) => r.fn === 'book_class_atomic_keyed')
}

// The CRITICAL logs every money path here raises when it holds. A resolved probe
// deliberately raises none, so counting them is how the two success tests below
// prove the recovery was treated as a recovery rather than as an incident.
function criticalLogs() {
  return vi
    .mocked(console.error)
    .mock.calls.filter((call) => typeof call[0] === 'string' && call[0].startsWith('CRITICAL'))
}

// Scripts the verifier read-back only; the two clash checks always come back
// empty so the booking reaches the insert.
function scriptVerifier(handler: (call: QueryCall) => Scripted): void {
  store.lessonsSelect = (call) => (isClashCheck(call) ? { data: [], error: null } : handler(call))
}

let errorSpy: { mockRestore: () => void }
let logSpy: { mockRestore: () => void }
// console.warn is the channel the RESOLVED probe reports on - deliberately not
// console.error, because a probe that answered is a recovery that completed and
// not a state anyone has to act on. Spied to keep the run's output clean, and
// asserted on in the probe tests below.
let warnSpy: { mockRestore: () => void }

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
  store.rpcRetryResults = {}
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

  store.adminProfile = { timezone: TEACHER_TZ }
  store.lessonsList = []
  store.lessonsListCount = 0
  store.lessonsListQueries = []

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  // Restored individually rather than through vi.restoreAllMocks() so the
  // implementations set in the vi.mock factories above survive the file.
  errorSpy.mockRestore()
  logSpy.mockRestore()
  warnSpy.mockRestore()
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

// ---------------------------------------------------------------------------
// The deduction ERRORS ambiguously and a same-key probe decides it
// ---------------------------------------------------------------------------
//
// The deductError fall-through - anything that is neither insufficient_hours nor
// training_not_active - was the one deduction path here with no compensation:
// the transaction may have committed before its response leg died, so the hours
// may or may not have moved and nothing in hand could say which.
//
// The per-request idempotency key makes it decidable, and ONE more call carrying
// the SAME key is the whole mechanism:
//
//   replayed: true  - the first call committed. The hours are already deducted
//                     and the ledger row exists; the probe just names it.
//   replayed: false - the first call never committed, and the probe has now
//                     performed the deduction itself.
//
// Both answers leave exactly ONE deduction on the books, so the booking
// continues on both. Every test below therefore pins the NUMBER of
// book_class_atomic_keyed calls - two on a probed path, one on the definite
// branches that must never probe - and pins that refund_hours_atomic is never
// dispatched, because a refund here would have no "was never deducted" guard to
// lean on and could credit hours that were never spent.

describe('POST /api/admin/classes - an ambiguous deduction failure is resolved by a same-key probe', () => {
  it('probe replays (the first call HAD committed): the booking continues on the existing ledger row, 201', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    // replayed: true is the probe reporting that the lost first call did commit.
    // lesson_id null is what gate 3 requires and what is true by construction:
    // that call died before it could ever reach the lessons insert, so its
    // ledger row cannot already be linked to a class.
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-probe-replay', replayed: true, lesson_id: null },
      error: null,
    }
    store.lessonInsert = { data: { id: 'lesson-probe-replay' }, error: null }

    const res = await POST(makeRequest())

    // Exactly TWO calls, and the second must carry the FIRST one's key. A freshly
    // minted key would deduct a second time instead of answering the question.
    expect(store.rpcs.map((r) => r.fn)).toEqual([
      'book_class_atomic_keyed',
      'book_class_atomic_keyed',
    ])
    const deductArgs = deductCalls().map((r) => r.args) as Array<Record<string, unknown>>
    expect(typeof deductArgs[0].p_idempotency_key).toBe('string')
    expect(deductArgs[1]).toEqual(deductArgs[0])

    // The booking really did continue: a meeting was minted, the lesson row was
    // written, and the ledger row the PROBE named carries the new lesson's id.
    expect(vi.mocked(createTeamsMeeting)).toHaveBeenCalled()
    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(store.updates).toContainEqual({
      table: 'hours_log',
      values: { lesson_id: 'lesson-probe-replay' },
    })

    // One deduction stands, so nothing is owed back, nothing is orphaned and
    // nobody has to look at it.
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(taskCalls()).toHaveLength(0)
    expect(criticalLogs()).toHaveLength(0)
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1)

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ lesson_id: 'lesson-probe-replay' })
  })

  it('probe does NOT replay (the first call never committed): the probe performs the deduction, 201', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-probe-fresh', replayed: false, lesson_id: null },
      error: null,
    }
    store.lessonInsert = { data: { id: 'lesson-probe-fresh' }, error: null }

    const res = await POST(makeRequest())

    expect(store.rpcs.map((r) => r.fn)).toEqual([
      'book_class_atomic_keyed',
      'book_class_atomic_keyed',
    ])
    const deductArgs = deductCalls().map((r) => r.args) as Array<Record<string, unknown>>
    expect(deductArgs[1]).toEqual(deductArgs[0])

    expect(vi.mocked(createTeamsMeeting)).toHaveBeenCalled()
    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(store.updates).toContainEqual({
      table: 'hours_log',
      values: { lesson_id: 'lesson-probe-fresh' },
    })

    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()
    expect(taskCalls()).toHaveLength(0)
    expect(criticalLogs()).toHaveLength(0)
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1)

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ lesson_id: 'lesson-probe-fresh' })
  })

  it('probe ERRORS too: still ambiguous, so nothing is booked and nothing is refunded, 500', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: null,
      error: { message: 'connection reset', code: 'PGRST301' },
    }

    const res = await POST(makeRequest())

    // The probe was attempted exactly once - no retry, no loop.
    expect(store.rpcs.map((r) => r.fn)).toEqual([
      'book_class_atomic_keyed',
      'book_class_atomic_keyed',
    ])

    // Nothing is booked on top of an unknown deduction, and refund_hours_atomic
    // is NOT dispatched: it has no "was never deducted" guard, so a blind refund
    // here could credit hours that were never spent.
    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    // The branch returns before the Teams call, so no meeting is ever minted and
    // there is nothing to orphan.
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to reserve hours. Please try again.' })
  })

  it('probe THROWS: the transport error is handled as a failed probe, not left to escape, 500', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    store.rpcRetryResults.book_class_atomic_keyed = { reject: new TypeError('fetch failed') }

    const res = await POST(makeRequest())

    expect(store.rpcs.map((r) => r.fn)).toEqual([
      'book_class_atomic_keyed',
      'book_class_atomic_keyed',
    ])
    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    // The 'Failed to reserve hours' body is the proof the throw was handled
    // INSIDE the deduction branch: escaping to the outer catch would have
    // produced 'Internal error' instead.
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to reserve hours. Please try again.' })
  })

  it('probe replays a ledger row that is already linked to a lesson: held, not booked on top of, 500', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: { message: 'socket hang up' } }
    // A key minted inside THIS request cannot name a row that is already linked -
    // the first call died before the lessons insert - so this is a key collision
    // or a contract drift, and booking on top of it is how a student ends up with
    // a second real class.
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: {
        log_id: 'hours-log-probe-linked',
        replayed: true,
        lesson_id: 'already-linked-lesson',
      },
      error: null,
    }

    const res = await POST(makeRequest())

    expect(store.rpcs.map((r) => r.fn)).toEqual([
      'book_class_atomic_keyed',
      'book_class_atomic_keyed',
    ])
    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(refundCalls()).toHaveLength(0)
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    // The linked lesson is the only row a human can act on, so the task names it.
    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_REQUESTED)
    expect(taskCalls()[0][0].lessonId).toBe('already-linked-lesson')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('insufficient_hours is DEFINITE and never probes: exactly ONE call, 400', async () => {
    store.rpcResults.book_class_atomic_keyed = {
      data: null,
      error: { message: 'insufficient_hours' },
    }
    // Scripted deliberately. If a definite branch ever grew a probe, this would
    // resolve it into a successful deduction and the assertions below would fail
    // loudly - rather than the route silently charging a student whose RPC had
    // already refused the booking outright.
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-must-never-be-used', replayed: false, lesson_id: null },
      error: null,
    }

    const res = await POST(makeRequest())

    expect(store.rpcs.map((r) => r.fn)).toEqual(['book_class_atomic_keyed'])
    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(400)
    // 10.0 is the fixture training's total_hours minus its hours_consumed - the
    // hoursRemaining the route interpolates into this message.
    expect(await res.json()).toEqual({
      error: `Insufficient hours. 10.0h remaining, ${HOURS_REQUESTED}h required.`,
    })
  })

  it('training_not_active is DEFINITE and never probes: exactly ONE call, 400', async () => {
    store.rpcResults.book_class_atomic_keyed = {
      data: null,
      error: { message: 'training_not_active' },
    }
    store.rpcRetryResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-must-never-be-used', replayed: false, lesson_id: null },
      error: null,
    }

    const res = await POST(makeRequest())

    expect(store.rpcs.map((r) => r.fn)).toEqual(['book_class_atomic_keyed'])
    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'This training is no longer active.' })
  })
})

// ---------------------------------------------------------------------------
// GET: the Date & Time sort direction
// ---------------------------------------------------------------------------
//
// This file had no GET harness - the anon/SSR mock answered for `trainings` and threw
// on every other table, because POST was the only handler ever driven here. The two
// branches added to that mock are the minimum GET needs (its profile-timezone read and
// its lessons list query); the service-role fake and every POST fixture are untouched.
//
// What each test pins is the .order() call the route actually issued. That is the ONE
// place a ?sort= value can reach the database, so asserting on the recorded direction is
// what proves the allow-list holds and the raw string is never passed through. The
// .range() and the response body are asserted alongside it because the sort param must
// not disturb pagination or the exact count.

describe('GET /api/admin/classes - Date & Time sort direction', () => {
  it('no ?sort= keeps the descending order this endpoint has always returned', async () => {
    const res = await GET(makeGetRequest(''))

    expect(res.status).toBe(200)
    expect(listQuery().orders).toEqual([
      { column: 'scheduled_at', ascending: false, nullsFirst: undefined },
    ])
    // Untouched by the sort param: page 1 is still rows 0-49 and the count is still exact.
    expect(listQuery().ranges).toEqual([[0, 49]])
    expect(await res.json()).toEqual({ lessons: [], total: 0, page: 1, pageSize: 50 })
  })

  it("?sort=asc orders scheduled_at ascending", async () => {
    const res = await GET(makeGetRequest('sort=asc'))

    expect(res.status).toBe(200)
    expect(listQuery().orders).toEqual([
      { column: 'scheduled_at', ascending: true, nullsFirst: undefined },
    ])
    expect(listQuery().ranges).toEqual([[0, 49]])
  })

  it("?sort=desc orders scheduled_at descending, identically to sending nothing", async () => {
    const res = await GET(makeGetRequest('sort=desc'))

    expect(res.status).toBe(200)
    expect(listQuery().orders).toEqual([
      { column: 'scheduled_at', ascending: false, nullsFirst: undefined },
    ])
    expect(listQuery().ranges).toEqual([[0, 49]])
  })

  it('the cancelled branch carries the direction on BOTH keys, and leaves nullsFirst alone', async () => {
    // cancelled_at is the primary key on this branch and scheduled_at its fallback for
    // legacy rows. If only one took the direction the list would run two ways at once.
    // nullsFirst is deliberately NOT flipped with it: it decides where the legacy
    // null-cancelled_at rows land, not which way the column runs.
    const res = await GET(makeGetRequest('status=cancelled&sort=asc'))

    expect(res.status).toBe(200)
    expect(listQuery().orders).toEqual([
      { column: 'cancelled_at', ascending: true, nullsFirst: false },
      { column: 'scheduled_at', ascending: true, nullsFirst: undefined },
    ])
  })

  it('the cancelled branch with no ?sort= is byte-for-byte what it always was', async () => {
    const res = await GET(makeGetRequest('status=cancelled'))

    expect(res.status).toBe(200)
    expect(listQuery().orders).toEqual([
      { column: 'cancelled_at', ascending: false, nullsFirst: false },
      { column: 'scheduled_at', ascending: false, nullsFirst: undefined },
    ])
  })

  it('an unrecognised ?sort= is rejected with a 400 and issues no query at all', async () => {
    // The allow-list is exact: case variants and long forms are not silently understood,
    // and an EMPTY ?sort= is a malformed value rather than an absent one - only a param
    // that is not present at all falls back to the descending default.
    for (const value of ['garbage', 'ASC', 'ascending', '']) {
      const res = await GET(makeGetRequest(`sort=${value}`))

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid sort' })
    }

    // The 400 is returned above the search pre-resolution and above the lessons query,
    // so a rejected value never reaches .order() - or any other query.
    expect(store.lessonsListQueries).toHaveLength(0)
  })
})
