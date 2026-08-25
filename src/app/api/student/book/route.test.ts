import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Lost-insert-response net for POST /api/student/book.
 *
 * Sibling of src/app/api/admin/classes/route.test.ts and built on the same
 * harness, but this route holds TWO different reversals and picking the wrong
 * one is itself a money bug: a fresh booking owes refund_hours_atomic against
 * the GROSS duration it deducted, while a reschedule owes
 * unwind_reschedule_atomic against a NET delta of (new - old). Dispatching a
 * refund on the reschedule branch would hand the student a full duration of
 * hours they never spent, and a count-only assertion would not see it - so
 * every test below asserts the exact sequence of RPC NAMES, not how many ran.
 *
 * As in the admin file the real verifier is deliberately NOT mocked. All three
 * verdicts are driven purely by scripting what the lessons read-back returns,
 * and the assertions are on the three things the route can get wrong:
 *
 *   - the reversal dispatched (or NOT) against a row that may be live;
 *   - cancelTeamsMeeting dispatched (or NOT) against what may be the student's
 *     live join link;
 *   - the status code, because a 409/500 invites a retry and BookingGridClient
 *     re-enables Confirm - a second real class.
 *
 * IDENTIFYING THE READ-BACK - the one thing that differs from the admin file.
 * There, exactly two lessons.select calls precede the insert (both clash
 * checks), so "not a clash check" identified the verifier. That is FALSE here:
 * the reschedule branch issues a THIRD lessons select, the old-lesson read keyed
 * on .eq('id', rescheduleId) with .maybeSingle(). A negative predicate would
 * count that as a verifier call and the "no read-back at all" assertions would
 * pass for the wrong reason. So the verifier is identified POSITIVELY instead -
 * it is the only lessons select carrying .limit(2) with no terminal - and the
 * proven-rollback tests additionally pin the exact number AND kind of every
 * lessons select recorded, so any future drift in that shape fails loudly.
 */

// -- Recorded call shape -----------------------------------------------------
type Scripted = { data: unknown; error: unknown } | { reject: unknown }

type QueryCall = {
  table: string
  columns: string
  eqs: Array<[string, unknown]>
  neqs: Array<[string, unknown]>
  iss: Array<[string, unknown]>
  gtes: Array<[string, unknown]>
  lts: Array<[string, unknown]>
  nots: Array<[string, string, unknown]>
  limits: number[]
  terminal: 'single' | 'maybeSingle' | null
  insertValues: Record<string, unknown> | null
  updateValues: Record<string, unknown> | null
}

// A lessons select is classified by its FILTERS, never by its position: the
// route issues up to four of them and a positional script would break the
// moment their order changed.
//
// 'verifier' is the positive predicate described in the header - .limit(2) and
// no terminal. Mode A and mode B both carry it; nothing else on this route
// does. It is tested FIRST so it can never be shadowed.
function classifyLessonsSelect(call: QueryCall): string {
  if (call.limits.includes(2) && call.terminal === null) return 'verifier'
  // The reschedule old-lesson read: the only lessons select with a terminal.
  if (call.terminal === 'maybeSingle' && call.eqs.some(([column]) => column === 'id')) {
    return 'old-lesson'
  }
  // Both clash checks are the only selects with an `lt` on scheduled_at.
  if (call.lts.some(([column]) => column === 'scheduled_at')) {
    if (call.eqs.some(([column]) => column === 'teacher_id')) return 'teacher-clash'
    if (call.eqs.some(([column]) => column === 'student_id')) return 'student-clash'
  }
  return 'unknown'
}

const store = vi.hoisted(() => ({
  froms: [] as string[],
  // Only awaited queries land here. A builder that was constructed and never
  // resolved is not a query, and the proven-rollback tests turn on that.
  lessonsSelectCalls: [] as QueryCall[],
  lessonInsertCalls: [] as QueryCall[],
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Scripted>,
  lessonInsert: { data: null, error: null } as Scripted,
  lessonsSelect: (() => ({ data: [], error: null })) as (call: QueryCall) => Scripted,
  assignedTeacher: null as unknown,
  assignedTeacherError: null as unknown,
  teacherProfile: null as unknown,
  oldLesson: null as unknown,
  studentRow: null as unknown,
  studentError: null as unknown,
  training: null as unknown,
  trainingError: null as unknown,
  teamsMeeting: { joinUrl: '', meetingId: '' },
  teamsFails: false,
  adminClientCount: 0,
}))

// -- Fake service-role client ------------------------------------------------
// Chainable builder that RECORDS table, select, every filter, insert, update
// and rpc, and resolves to a scripted result. `then` honours both callbacks so
// a query can REJECT mid-flight - the lost-response shape - rather than only
// throwing synchronously. Recording is the point: several tests below prove a
// query did not happen at all.
vi.mock('@/lib/supabase/admin', () => {
  const KNOWN_TABLES = ['training_teachers', 'profiles', 'lessons', 'hours_log']

  function resolveScripted(call: QueryCall): Scripted {
    if (call.table === 'training_teachers') {
      return { data: store.assignedTeacher, error: store.assignedTeacherError }
    }
    if (call.table === 'profiles') return { data: store.teacherProfile, error: null }
    if (call.table === 'hours_log') return { data: null, error: null }
    if (call.table === 'lessons') {
      if (call.insertValues !== null) {
        store.lessonInsertCalls.push(call)
        return store.lessonInsert
      }
      // The post-commit Teams-column null on the rescheduled-from row. Never
      // reached by the tests below (every verdict branch returns first), but
      // scripted so a drift shows up as a failed assertion rather than a crash.
      if (call.updateValues !== null) return { data: [{ id: 'old-lesson-row' }], error: null }
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
          neqs: [],
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
          neq(column: string, value: unknown) {
            call.neqs.push([column, value])
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

// The anon/SSR client: the auth check, the students ownership read and the
// trainings balance read. Both reads terminate in .single().
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-student-1' } }, error: null }),
    },
    from(table: string) {
      if (table !== 'students' && table !== 'trainings') {
        throw new Error(`unexpected table in test: ${table}`)
      }
      const builder = {
        select() {
          return builder
        },
        eq() {
          return builder
        },
        single: async () =>
          table === 'students'
            ? { data: store.studentRow, error: store.studentError }
            : { data: store.training, error: store.trainingError },
      }
      return builder
    },
  }),
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

// Availability is a whole engine of its own with its own tests; here it only
// has to let the booking through to the money path.
vi.mock('@/lib/availability', () => ({
  isSlotAvailable: vi.fn(async () => true),
}))

vi.mock('@/lib/rateLimit', () => ({
  checkStudentBookingLimit: vi.fn(async () => ({ blocked: false, retryAfterSeconds: 0 })),
  recordStudentBookingAttempt: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/lib/reports/createPendingReport', () => ({
  createPendingReport: vi.fn(async () => ({ error: null })),
}))

vi.mock('@/lib/google/lessonEvents', () => ({
  createLessonGoogleEvent: vi.fn(async () => undefined),
  deleteLessonGoogleEvent: vi.fn(async () => undefined),
}))

vi.mock('@/lib/admin/raiseReconciliationTask', () => ({
  raiseReconciliationTask: vi.fn(async () => undefined),
}))

// @/lib/lessons/verifyLessonCommitted is deliberately NOT mocked - the point of
// this file is that the route drives the real helper. @/lib/validation/schemas,
// @/lib/billing/billability, @/lib/time/requireTz and @/lib/email/templates are
// left real too: the first two are load-bearing for what these tests assert,
// and neither of the others has module-level side effects.

// Imported AFTER the mocks are registered.
import { POST } from './route'
import { cancelTeamsMeeting, createTeamsMeeting } from '@/lib/microsoft/graph'
import { raiseReconciliationTask } from '@/lib/admin/raiseReconciliationTask'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { NextRequest } from 'next/server'

// -- Fixtures ----------------------------------------------------------------
const TEACHER_ID = '11111111-1111-4111-8111-111111111111'
const STUDENT_ID = '22222222-2222-4222-8222-222222222222'
const TRAINING_ID = '33333333-3333-4333-8333-333333333333'
const OLD_LESSON_ID = '44444444-4444-4444-8444-444444444444'
const TEACHER_TZ = 'Europe/Brussels'
const STUDENT_TZ = 'Asia/Tokyo'
// Far future so neither 24-hour rule can ever fire with the clock.
const SCHEDULED_AT_ISO = '2030-01-15T10:00:00.000Z'
const OLD_SCHEDULED_AT_ISO = '2030-01-10T10:00:00.000Z'
const DURATION_MINUTES = 60
// The full duration the fresh-book path deducts, and - because the reschedule
// duration lock pins new to old - also the GROSS new duration the reschedule
// paths report. The reschedule NET delta is 0, so an assertion of 1 here is
// exactly what catches a net-for-gross regression.
const HOURS_NEEDED = 1
const TEAMS_MEETING_ID = 'graph-meeting-student-1'

// Built from its code point rather than typed literally: this file is otherwise
// pure ASCII, and the route's 409 copy is the one string that is not.
const EM_DASH = String.fromCharCode(0x2014)

const BASE_BODY = {
  trainingId: TRAINING_ID,
  teacherId: TEACHER_ID,
  studentId: STUDENT_ID,
  durationMinutes: DURATION_MINUTES,
  scheduledAt: SCHEDULED_AT_ISO,
}

const RESCHEDULE_BODY = { ...BASE_BODY, rescheduleId: OLD_LESSON_ID }

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/student/book', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function lessonsSelectKinds(): string[] {
  return store.lessonsSelectCalls.map(classifyLessonsSelect)
}

function verifierCalls(): QueryCall[] {
  return store.lessonsSelectCalls.filter((call) => classifyLessonsSelect(call) === 'verifier')
}

function rpcNames(): string[] {
  return store.rpcs.map((r) => r.fn)
}

function rpcArgs(fn: string): unknown[] {
  return store.rpcs.filter((r) => r.fn === fn).map((r) => r.args)
}

function taskCalls() {
  return vi.mocked(raiseReconciliationTask).mock.calls
}

// Everything that is not the verifier read-back answers from the fixtures: the
// two clash checks come back empty so the booking reaches the insert, and the
// reschedule branch gets its old lesson.
function defaultLessonsSelect(call: QueryCall): Scripted {
  if (classifyLessonsSelect(call) === 'old-lesson') {
    return { data: store.oldLesson, error: null }
  }
  return { data: [], error: null }
}

// Scripts the verifier read-back ONLY - identified positively, so the
// reschedule old-lesson read can never be mistaken for it.
function scriptVerifier(handler: (call: QueryCall) => Scripted): void {
  store.lessonsSelect = (call) =>
    classifyLessonsSelect(call) === 'verifier' ? handler(call) : defaultLessonsSelect(call)
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
    reschedule_class_atomic: { data: null, error: null },
    refund_hours_atomic: { data: { success: true }, error: null },
    // data true = the original lesson was restored, so the reschedule failure
    // paths take their restored-original branch rather than the null
    // fall-through.
    unwind_reschedule_atomic: { data: true, error: null },
  }
  store.lessonInsert = { data: null, error: null }
  store.lessonsSelect = defaultLessonsSelect
  store.assignedTeacher = { teacher_id: TEACHER_ID }
  store.assignedTeacherError = null
  store.teacherProfile = {
    id: TEACHER_ID,
    full_name: 'Teacher One',
    email: 'teacher@example.com',
    timezone: TEACHER_TZ,
  }
  store.oldLesson = {
    duration_minutes: DURATION_MINUTES,
    teams_meeting_id: null,
    teams_join_url: null,
    scheduled_at: OLD_SCHEDULED_AT_ISO,
    training_id: TRAINING_ID,
    teacher_id: TEACHER_ID,
  }
  store.studentRow = {
    id: STUDENT_ID,
    full_name: 'Student One',
    email: 'student@example.com',
    timezone: STUDENT_TZ,
    auth_user_id: 'auth-student-1',
    profile_completed: true,
    allowed_durations: [30, 60, 90],
  }
  store.studentError = null
  store.training = {
    id: TRAINING_ID,
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

describe('POST /api/student/book - a proven rollback still short-circuits', () => {
  it('fresh book, 23P01: no read-back at all, refund_hours_atomic dispatched, 409', async () => {
    store.lessonInsert = {
      data: null,
      error: {
        code: '23P01',
        message: 'conflicting key value violates exclusion constraint "no_teacher_overlap"',
        details: null,
      },
    }

    const res = await POST(makeRequest(BASE_BODY))

    // isRollbackProven is true, so the route must not issue the read-back. The
    // exact kinds are pinned, not just the absence of a verifier call: a fresh
    // book issues precisely the two clash checks and nothing else.
    expect(verifierCalls()).toHaveLength(0)
    expect(lessonsSelectKinds()).toEqual(['teacher-clash', 'student-clash'])

    // The NAME matters more than the count: unwind_reschedule_atomic here would
    // reverse a reschedule that never happened.
    expect(rpcNames()).toEqual(['book_class_atomic_keyed', 'refund_hours_atomic'])
    expect(rpcArgs('refund_hours_atomic')).toEqual([
      { p_training_id: TRAINING_ID, p_hours: HOURS_NEEDED },
    ])

    // No row points at the meeting, so the orphan is cancelled as before.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'SLOT_NOT_AVAILABLE',
      message: 'This slot was just booked by another student. Please choose a different time.',
    })
  })

  it('reschedule, 23P01: no read-back at all, unwind_reschedule_atomic dispatched, 409', async () => {
    store.lessonInsert = {
      data: null,
      error: {
        code: '23P01',
        message: 'conflicting key value violates exclusion constraint "no_teacher_overlap"',
        details: null,
      },
    }

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    // THREE lessons selects on this branch, not two - the old-lesson read is
    // the extra one, and pinning its kind is what stops it ever being counted
    // as a verifier call.
    expect(verifierCalls()).toHaveLength(0)
    expect(lessonsSelectKinds()).toEqual(['teacher-clash', 'student-clash', 'old-lesson'])

    // refund_hours_atomic here would refund a GROSS duration against a
    // net-delta deduction and hand the student hours they never spent.
    expect(rpcNames()).toEqual(['reschedule_class_atomic', 'unwind_reschedule_atomic'])
    expect(rpcArgs('unwind_reschedule_atomic')).toEqual([
      {
        p_old_lesson_id: OLD_LESSON_ID,
        p_training_id: TRAINING_ID,
        p_old_duration_hours: HOURS_NEEDED,
        p_new_duration_hours: HOURS_NEEDED,
      },
    ])

    // Only the NEW meeting is cancelled; the original lesson keeps its own.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'SLOT_NOT_AVAILABLE',
      message:
        'That time was just booked by someone else. Your original class is unchanged ' +
        EM_DASH +
        ' please choose a different time.',
    })
  })
})

// ---------------------------------------------------------------------------
// Fresh book - the insert RETURNS an unproven error
// ---------------------------------------------------------------------------

describe('POST /api/student/book - fresh book, an unproven insert error is resolved by reading back', () => {
  it('committed (mode A finds this request meeting id): no refund, no Teams cancel, 200', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier((call) => {
      // Mode A: the row is identified by the meeting the fake Graph call minted.
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      expect(call.limits).toEqual([2])
      expect(call.terminal).toBeNull()
      return { data: [{ id: 'lesson-committed-1' }], error: null }
    })

    const res = await POST(makeRequest(BASE_BODY))

    expect(verifierCalls()).toHaveLength(1)
    // The class exists: reversing the hours would cancel a live class, and the
    // meeting is now that class's join link.
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, lessonId: 'lesson-committed-1' })
  })

  it('unresolved (the read-back itself errors): no refund, no Teams cancel, 500', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: null, error: { message: 'connection reset', code: 'PGRST301' } }))

    const res = await POST(makeRequest(BASE_BODY))

    expect(verifierCalls()).toHaveLength(1)
    // Neither state is proven and the dangerous half is a committed row, so
    // nothing is written and a human decides.
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('not_committed (zero rows): the refund is genuinely owed and IS dispatched', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest(BASE_BODY))

    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed', 'refund_hours_atomic'])
    expect(rpcArgs('refund_hours_atomic')).toEqual([
      { p_training_id: TRAINING_ID, p_hours: HOURS_NEEDED },
    ])
    // No row points at the meeting, so the orphan is cancelled.
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

    const res = await POST(makeRequest(BASE_BODY))

    expect(vi.mocked(createTeamsMeeting)).toHaveBeenCalled()
    expect(verifierCalls()).toHaveLength(1)

    // The recorded filters really are the mode B shape - natural key, the
    // teams_meeting_id IS NULL narrowing, the created_at floor, the cancelled
    // exclusion, and limit(2) with no terminal.
    const call = modeBCall as unknown as QueryCall
    expect(call.eqs).toEqual([
      ['teacher_id', TEACHER_ID],
      ['student_id', STUDENT_ID],
      ['training_id', TRAINING_ID],
      ['scheduled_at', SCHEDULED_AT_ISO],
      ['duration_minutes', DURATION_MINUTES],
    ])
    expect(call.iss).toEqual([['teams_meeting_id', null]])
    expect(call.gtes.map(([column]) => column)).toEqual(['created_at'])
    expect(call.nots).toEqual([['status', 'in', toPostgrestInList(CANCELLED_STATUSES)]])
    expect(call.limits).toEqual([2])
    expect(call.terminal).toBeNull()

    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })
})

// ---------------------------------------------------------------------------
// Fresh book - book_class_atomic_keyed answers, but not in its contracted shape
// ---------------------------------------------------------------------------
//
// These three sit one step EARLIER than every test above: the RPC does not
// error, so the deductError fall-through never runs, but its jsonb payload
// cannot be trusted to say whether the hours moved. Every one of them asserts
// the same three things, because all three are the ways this path could lose a
// student money:
//
//   - no lessons insert, so nothing is booked on top of an unknown deduction;
//   - no refund_hours_atomic, because refund_hours_atomic has no "was never
//     deducted" guard and pendingCompensation must never have been armed. The
//     exact RPC-name sequence is asserted, not a count, for the reason the file
//     header gives;
//   - 500, never a 409 - a 409 asserts the hours are safe, and here nothing
//     proves that.
//
// A reconciliation task is what makes these paths visible to a human, so its
// presence and the hours it names are asserted too.

describe('POST /api/student/book - a malformed or replayed deduction payload holds the booking', () => {
  it('replayed: true holds - no lessons insert, no refund, 500', async () => {
    // lesson_id null is the trap this test exists for. The 6a backfill is
    // best-effort, so a null stored lesson id does NOT prove no lesson exists -
    // reading it as "nothing was booked" and refunding would credit hours that
    // may be paying for a live class.
    store.rpcResults.book_class_atomic_keyed = {
      data: { log_id: 'hours-log-replay-1', replayed: true, lesson_id: null },
      error: null,
    }

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(rpcNames()).not.toContain('refund_hours_atomic')
    // The gate returns before section 5, so no meeting is ever minted and there
    // is nothing to orphan.
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('data null with error null holds - no lessons insert, no refund, 500', async () => {
    store.rpcResults.book_class_atomic_keyed = { data: null, error: null }

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(rpcNames()).not.toContain('refund_hours_atomic')
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
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

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(0)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(rpcNames()).not.toContain('refund_hours_atomic')
    expect(vi.mocked(createTeamsMeeting)).not.toHaveBeenCalled()
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })
})

// ---------------------------------------------------------------------------
// Reschedule - the insert RETURNS an unproven error
// ---------------------------------------------------------------------------

describe('POST /api/student/book - reschedule, an unproven insert error is resolved by reading back', () => {
  it('committed (mode A): NO unwind, no Teams cancel, 200 with the verified row id', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier((call) => {
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      return { data: [{ id: 'lesson-committed-resched-1' }], error: null }
    })

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(lessonsSelectKinds()).toEqual([
      'teacher-clash',
      'student-clash',
      'old-lesson',
      'verifier',
    ])
    // The reschedule SUCCEEDED and only the reply died: restoring the old
    // lesson would sit it alongside a live new one.
    expect(rpcNames()).toEqual(['reschedule_class_atomic'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-resched-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, lessonId: 'lesson-committed-resched-1' })
  })

  it('unresolved (the read-back itself errors): no unwind, no Teams cancel, task carries GROSS hours against the OLD lesson id, 500', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: null, error: { message: 'connection reset', code: 'PGRST301' } }))

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['reschedule_class_atomic'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    // The money assertion. If the insert DID roll back, hours_consumed sits at
    // old + (new - old) = the full new duration with zero lessons held, so the
    // GROSS new duration is the student's exposure - the net delta would report
    // 0. And it is reported against the OLD lesson id, the only row a human can
    // act on, because no new row is known to exist.
    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBe(OLD_LESSON_ID)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create booking. Please try again.' })
  })

  it('not_committed (zero rows): the unwind is genuinely owed and IS dispatched', async () => {
    store.lessonInsert = { data: null, error: { message: 'socket hang up' } }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['reschedule_class_atomic', 'unwind_reschedule_atomic'])
    expect(rpcArgs('unwind_reschedule_atomic')).toEqual([
      {
        p_old_lesson_id: OLD_LESSON_ID,
        p_training_id: TRAINING_ID,
        p_old_duration_hours: HOURS_NEEDED,
        p_new_duration_hours: HOURS_NEEDED,
      },
    ])
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    // The unwind landed, so nothing is owed to a human.
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// The insert REJECTS, so the outer catch owns the verdict
// ---------------------------------------------------------------------------

describe('POST /api/student/book - a throw AT the insert is resolved in the outer catch', () => {
  it('fresh book, committed: no refund, no Teams cancel, 200 with the verified row id', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier((call) => {
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      return { data: [{ id: 'lesson-committed-2' }], error: null }
    })

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-2')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, lessonId: 'lesson-committed-2' })
  })

  it('fresh book, unresolved: no refund, no Teams cancel, task carries the deducted hours, 500', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: null, error: { message: 'statement timeout', code: '57014' } }))

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['book_class_atomic_keyed'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBeNull()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred. Please try again.' })
  })

  it('reschedule, committed: NO unwind, no Teams cancel, 200 with the verified row id', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier((call) => {
      expect(call.eqs).toEqual([['teams_meeting_id', TEAMS_MEETING_ID]])
      return { data: [{ id: 'lesson-committed-resched-2' }], error: null }
    })

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['reschedule_class_atomic'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBeNull()
    expect(taskCalls()[0][0].lessonId).toBe('lesson-committed-resched-2')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, lessonId: 'lesson-committed-resched-2' })
  })

  it('reschedule, unresolved: no unwind, no Teams cancel, task carries GROSS hours against the OLD lesson id, 500', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: null, error: { message: 'statement timeout', code: '57014' } }))

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(rpcNames()).toEqual(['reschedule_class_atomic'])
    expect(vi.mocked(cancelTeamsMeeting)).not.toHaveBeenCalled()

    // Same money assertion as the insert-error twin above: GROSS, not the net
    // delta, and named against the OLD lesson id.
    expect(taskCalls()).toHaveLength(1)
    expect(taskCalls()[0][0].hours).toBe(HOURS_NEEDED)
    expect(taskCalls()[0][0].lessonId).toBe(OLD_LESSON_ID)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred. Please try again.' })
  })

  it('fresh book, not_committed: the refund is owed and IS dispatched, through a fresh client, 500', async () => {
    // Both halves are needed to reach the compensation block from the outer
    // catch: the insert must REJECT (so no insert-handler verdict runs) and the
    // read-back must then prove no row exists.
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest(BASE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)

    // The specific behaviour this test exists to reach: the route's own
    // adminClient is scoped to the try and may never have been constructed, so
    // both the read-back and the reversal below build their own.
    expect(store.adminClientCount).toBeGreaterThan(1)

    // The NAME matters more than the count: unwind_reschedule_atomic here would
    // reverse a reschedule that never happened.
    expect(rpcNames()).toEqual(['book_class_atomic_keyed', 'refund_hours_atomic'])
    expect(rpcArgs('refund_hours_atomic')).toEqual([
      { p_training_id: TRAINING_ID, p_hours: HOURS_NEEDED },
    ])

    // No row points at the meeting, so the orphan is cancelled.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    // The refund landed, so nothing is owed to a human.
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred. Please try again.' })
  })

  it('reschedule, not_committed: the unwind is owed and IS dispatched, through a fresh client, 500', async () => {
    store.lessonInsert = { reject: new TypeError('fetch failed') }
    scriptVerifier(() => ({ data: [], error: null }))

    const res = await POST(makeRequest(RESCHEDULE_BODY))

    expect(store.lessonInsertCalls).toHaveLength(1)
    expect(verifierCalls()).toHaveLength(1)
    expect(store.adminClientCount).toBeGreaterThan(1)

    // The assertion that matters most on this path. refund_hours_atomic here
    // would reverse a GROSS duration against a net-delta deduction and hand the
    // student a full hour they never spent - and a count-only assertion would
    // not see it, because both reversals are exactly one RPC.
    expect(rpcNames()).toEqual(['reschedule_class_atomic', 'unwind_reschedule_atomic'])
    expect(rpcArgs('unwind_reschedule_atomic')).toEqual([
      {
        p_old_lesson_id: OLD_LESSON_ID,
        p_training_id: TRAINING_ID,
        p_old_duration_hours: HOURS_NEEDED,
        p_new_duration_hours: HOURS_NEEDED,
      },
    ])

    // Only the NEW meeting is cancelled; the original lesson keeps its own.
    expect(vi.mocked(cancelTeamsMeeting)).toHaveBeenCalledWith(TEAMS_MEETING_ID)
    // The unwind landed, so nothing is owed to a human.
    expect(taskCalls()).toHaveLength(0)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred. Please try again.' })
  })
})
