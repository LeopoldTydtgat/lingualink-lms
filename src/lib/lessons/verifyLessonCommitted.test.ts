import { describe, expect, it } from 'vitest'
import type { createAdminClient } from '@/lib/supabase/admin'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import {
  isRollbackProven,
  verifyLessonCommitted,
  type VerifyLessonCommittedParams,
} from './verifyLessonCommitted'

/**
 * Regression net for the lost-insert-response verifier.
 *
 * The properties worth pinning here are the ones no caller can observe, because
 * every call site is already inside a booking failure handler holding hours it
 * must either give back or keep:
 *
 *  - isRollbackProven says true ONLY for a real Postgres SQLSTATE. Anything
 *    else is "unproven", and unproven must never read as "committed";
 *  - mode A (Teams meeting id present) is exact in both directions, because the
 *    id is minted per request;
 *  - mode B (no meeting id) NEVER returns 'committed', even when a row matches
 *    the natural key. That row could belong to a concurrent duplicate
 *    submission; claiming it would skip a refund that is owed and double-deduct
 *    the student. The one-row mode B case below is the anti-regression test for
 *    exactly that;
 *  - the helper never throws, whatever the client does;
 *  - mode B's query really does exclude the cancelled family and really does
 *    bound created_at, rather than merely being commented as if it did.
 */

type AdminClient = ReturnType<typeof createAdminClient>

// -- Fake service-role client ------------------------------------------------
// One table (`lessons`), one chainable builder that records every filter it is
// handed and resolves to a scripted { data, error }. The recording is the point:
// several tests below prove a filter WAS applied, and one proves the status
// exclusion was NOT applied in mode A. The builder throws on any other table so
// a query that drifts onto the wrong one fails loudly instead of passing.
//
// Unlike raiseReconciliationTask.test.ts / lessonEvents.test.ts, there is no
// vi.mock('@/lib/supabase/admin') here: verifyLessonCommitted takes its client
// as a parameter, so the fake is handed straight in.
type QueryResult = { data: Array<{ id: string }> | null; error: { message: string; code?: string } | null }

type Recorder = {
  tables: string[]
  selects: string[]
  eqs: Array<[string, unknown]>
  iss: Array<[string, unknown]>
  gtes: Array<[string, unknown]>
  nots: Array<[string, string, unknown]>
  limits: number[]
}

function newRecorder(): Recorder {
  return { tables: [], selects: [], eqs: [], iss: [], gtes: [], nots: [], limits: [] }
}

function makeClient(
  result: QueryResult,
  opts: { throwOnQuery?: unknown; rejectWith?: unknown } = {},
): { client: AdminClient; rec: Recorder } {
  const rec = newRecorder()

  const builder = {
    select(columns: string) {
      rec.selects.push(columns)
      return builder
    },
    eq(column: string, value: unknown) {
      rec.eqs.push([column, value])
      return builder
    },
    is(column: string, value: unknown) {
      rec.iss.push([column, value])
      return builder
    },
    gte(column: string, value: unknown) {
      rec.gtes.push([column, value])
      return builder
    },
    not(column: string, operator: string, value: unknown) {
      rec.nots.push([column, operator, value])
      return builder
    },
    limit(count: number) {
      rec.limits.push(count)
      return builder
    },
    // A genuine thenable: both callbacks are honoured, so a REJECTING query -
    // the lost-response shape verifyLessonCommitted exists for - can be
    // simulated, not just a synchronous throw from from().
    then(resolve: (r: QueryResult) => void, reject?: (e: unknown) => void) {
      if ('rejectWith' in opts) {
        reject?.(opts.rejectWith)
        return
      }
      resolve(result)
    },
  }

  const client = {
    from(table: string) {
      rec.tables.push(table)
      if (table !== 'lessons') {
        throw new Error(`unexpected table in test: ${table}`)
      }
      if ('throwOnQuery' in opts) {
        throw opts.throwOnQuery
      }
      return builder
    },
  }

  return { client: client as unknown as AdminClient, rec }
}

const REQUEST_START = '2026-08-24T09:59:58.000Z'

const BASE: VerifyLessonCommittedParams = {
  teamsMeetingId: 'graph-meeting-abc',
  teacherId: 'teacher-1',
  studentId: 'student-1',
  trainingId: 'training-1',
  scheduledAtIso: '2026-08-25T10:00:00.000Z',
  durationMinutes: 60,
  requestStartIso: REQUEST_START,
}

// ---------------------------------------------------------------------------
// isRollbackProven
// ---------------------------------------------------------------------------

describe('isRollbackProven - only a statement-level SQLSTATE proves a rollback', () => {
  it('is true for 23P01 (exclusion violation - the slot-conflict constraint)', () => {
    expect(isRollbackProven({ code: '23P01', message: 'conflicting key value' })).toBe(true)
  })

  it('is true for P0001 (raise_exception from a trigger)', () => {
    expect(isRollbackProven({ code: 'P0001', message: 'no hours remaining' })).toBe(true)
  })

  it('is true for 23503 (foreign key violation)', () => {
    expect(isRollbackProven({ code: '23503', message: 'training_id not present' })).toBe(true)
  })

  // 57014 vs 57P01 is THE distinction this pair exists to hold open. Both are
  // class 57 and only one of them proves anything:
  //
  //   57014 query_canceled  - a statement_timeout fired. The backend was alive,
  //                           it rejected OUR statement and answered. TRUE.
  //   57P01 admin_shutdown  - the backend itself was terminated. A COMMIT may
  //                           already have landed unacknowledged. FALSE.
  //
  // Do not collapse these into a whole-class-57 rule in either direction:
  // excluding all of 57 buys a pointless read-back on every timeout, and
  // dropping the 57P guard re-opens compensating against a live class.
  it('is true for 57014 (query_canceled - a statement timeout IS a statement-level rejection)', () => {
    expect(isRollbackProven({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(true)
  })

  it('is FALSE for 57P01 (admin_shutdown - the backend was terminated, a commit may have landed)', () => {
    expect(isRollbackProven({ code: '57P01', message: 'terminating connection due to administrator command' })).toBe(false)
  })

  it('is FALSE for 57P03 (cannot_connect_now)', () => {
    expect(isRollbackProven({ code: '57P03', message: 'the database system is starting up' })).toBe(false)
  })

  it('is FALSE for 08006 (connection_failure - the link died, the commit may not have)', () => {
    expect(isRollbackProven({ code: '08006', message: 'connection failure' })).toBe(false)
  })

  it('is FALSE for 08003 (connection_does_not_exist)', () => {
    expect(isRollbackProven({ code: '08003', message: 'connection does not exist' })).toBe(false)
  })

  it('is FALSE for 08001 (sqlclient_unable_to_establish_sqlconnection)', () => {
    expect(isRollbackProven({ code: '08001', message: 'could not connect to server' })).toBe(false)
  })

  it('is FALSE for PGRST116 - a PostgREST client code says nothing about the transaction', () => {
    expect(isRollbackProven({ code: 'PGRST116', message: 'no rows returned' })).toBe(false)
  })

  it('is FALSE for the bare five-character PGRST, which the length test alone would admit', () => {
    expect(isRollbackProven({ code: 'PGRST' })).toBe(false)
  })

  it('is FALSE for undefined', () => {
    expect(isRollbackProven(undefined)).toBe(false)
  })

  it('is FALSE for null', () => {
    expect(isRollbackProven(null)).toBe(false)
  })

  it('is FALSE for a thrown Error - a transport failure proves nothing', () => {
    expect(isRollbackProven(new Error('fetch failed'))).toBe(false)
  })

  it('is FALSE for an empty code', () => {
    expect(isRollbackProven({ code: '' })).toBe(false)
  })

  it('is FALSE for an object with no code at all', () => {
    expect(isRollbackProven({ message: 'x' })).toBe(false)
  })

  it('is FALSE for a lowercase 23p01 - lowercase is not a SQLSTATE', () => {
    expect(isRollbackProven({ code: '23p01' })).toBe(false)
  })

  it('is FALSE for a bare string, which carries no code property', () => {
    expect(isRollbackProven('23P01')).toBe(false)
  })

  it('is FALSE for a non-string code', () => {
    expect(isRollbackProven({ code: 23501 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mode A - a Teams meeting id identifies this request's row exactly
// ---------------------------------------------------------------------------

describe('verifyLessonCommitted mode A - keyed on the per-request Teams meeting id', () => {
  it('one row -> committed, carrying that row id', async () => {
    const { client, rec } = makeClient({ data: [{ id: 'lesson-9' }], error: null })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict).toEqual({ outcome: 'committed', lessonId: 'lesson-9' })
    expect(rec.tables).toEqual(['lessons'])
    expect(rec.selects).toEqual(['id'])
    expect(rec.eqs).toEqual([['teams_meeting_id', 'graph-meeting-abc']])
    expect(rec.limits).toEqual([2])
  })

  it('does NOT filter on status - a row cancelled after the insert still proves it committed', async () => {
    const { client, rec } = makeClient({ data: [{ id: 'lesson-9' }], error: null })

    await verifyLessonCommitted(client, BASE)

    expect(rec.nots).toEqual([])
  })

  it('zero rows -> not_committed', async () => {
    const { client } = makeClient({ data: [], error: null })

    expect(await verifyLessonCommitted(client, BASE)).toEqual({ outcome: 'not_committed' })
  })

  it('null data with no error -> not_committed', async () => {
    const { client } = makeClient({ data: null, error: null })

    expect(await verifyLessonCommitted(client, BASE)).toEqual({ outcome: 'not_committed' })
  })

  it('a query error -> unresolved / verify_failed, carrying the error', async () => {
    const error = { message: 'connection reset', code: 'PGRST301' }
    const { client } = makeClient({ data: null, error })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(error)
  })

  it('two rows -> unresolved / ambiguous_row, and never picks one', async () => {
    const { client } = makeClient({ data: [{ id: 'lesson-9' }, { id: 'lesson-10' }], error: null })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('ambiguous_row')
    expect(JSON.stringify(verdict)).not.toContain('lesson-9')
  })

  it('a client that throws -> unresolved / verify_failed, never a rethrow', async () => {
    const boom = new TypeError('fetch failed')
    const { client } = makeClient({ data: [], error: null }, { throwOnQuery: boom })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(boom)
  })

  it('a query that REJECTS mid-flight (lost response, not a synchronous throw) -> unresolved / verify_failed', async () => {
    // This is the actual production case the helper exists for: the awaited
    // query itself rejects (socket reset, serverless timeout) rather than
    // from() throwing synchronously before any await happens.
    const lost = new TypeError('socket hang up')
    const { client } = makeClient({ data: [], error: null }, { rejectWith: lost })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(lost)
  })
})

// ---------------------------------------------------------------------------
// Mode B - no meeting id, natural key only. Absence provable, presence not.
// ---------------------------------------------------------------------------

const MODE_B: VerifyLessonCommittedParams = { ...BASE, teamsMeetingId: null }

describe('verifyLessonCommitted mode B - natural key, never conclusive in the positive', () => {
  it('zero rows -> not_committed (absence IS provable)', async () => {
    const { client } = makeClient({ data: [], error: null })

    expect(await verifyLessonCommitted(client, MODE_B)).toEqual({ outcome: 'not_committed' })
  })

  it('ONE matching row -> ambiguous_row, NOT committed (anti-regression: double-deduct)', async () => {
    // A single natural-key match is the tempting case: it looks exactly like
    // "our row committed". It is not - a concurrent duplicate submission
    // produces the identical row. Claiming it would skip a refund that is owed.
    const { client } = makeClient({ data: [{ id: 'lesson-11' }], error: null })

    const verdict = await verifyLessonCommitted(client, MODE_B)

    expect(verdict.outcome).not.toBe('committed')
    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('ambiguous_row')
    // The row id must not leak out as something a caller could act on.
    expect(JSON.stringify(verdict)).not.toContain('lesson-11')
  })

  it('two matching rows -> ambiguous_row', async () => {
    const { client } = makeClient({ data: [{ id: 'a' }, { id: 'b' }], error: null })

    const verdict = await verifyLessonCommitted(client, MODE_B)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('ambiguous_row')
  })

  it('a query error -> unresolved / verify_failed', async () => {
    const error = { message: 'statement timeout', code: '57014' }
    const { client } = makeClient({ data: null, error })

    const verdict = await verifyLessonCommitted(client, MODE_B)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(error)
  })

  it('a client that throws -> unresolved / verify_failed', async () => {
    const boom = new Error('socket hang up')
    const { client } = makeClient({ data: [], error: null }, { throwOnQuery: boom })

    const verdict = await verifyLessonCommitted(client, MODE_B)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(boom)
  })

  it('a query that REJECTS mid-flight (lost response, not a synchronous throw) -> unresolved / verify_failed', async () => {
    // Same lost-response shape as mode A's equivalent test above, proven here
    // for the natural-key query too.
    const lost = new Error('statement timeout')
    const { client } = makeClient({ data: [], error: null }, { rejectWith: lost })

    const verdict = await verifyLessonCommitted(client, MODE_B)

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('verify_failed')
    expect(verdict.detail).toBe(lost)
  })

  it('applies the whole natural key, the NULL meeting id and limit(2)', async () => {
    const { client, rec } = makeClient({ data: [], error: null })

    await verifyLessonCommitted(client, MODE_B)

    expect(rec.tables).toEqual(['lessons'])
    expect(rec.selects).toEqual(['id'])
    expect(rec.eqs).toEqual([
      ['teacher_id', 'teacher-1'],
      ['student_id', 'student-1'],
      ['training_id', 'training-1'],
      ['scheduled_at', '2026-08-25T10:00:00.000Z'],
      ['duration_minutes', 60],
    ])
    expect(rec.iss).toEqual([['teams_meeting_id', null]])
    expect(rec.limits).toEqual([2])
  })

  it('excludes the CANCELLED family via the canonical billability pair', async () => {
    const { client, rec } = makeClient({ data: [], error: null })

    await verifyLessonCommitted(client, MODE_B)

    expect(rec.nots).toEqual([['status', 'in', toPostgrestInList(CANCELLED_STATUSES)]])
    // Not just shape: the rendered filter really names every cancelled status,
    // so a hand-written list that drifted from billability.ts would fail here.
    const rendered = String(rec.nots[0][2])
    expect(CANCELLED_STATUSES.length).toBeGreaterThan(0)
    for (const status of CANCELLED_STATUSES) {
      expect(rendered).toContain(`"${status}"`)
    }
  })

  it('bounds created_at at the start of this request', async () => {
    const { client, rec } = makeClient({ data: [], error: null })

    await verifyLessonCommitted(client, MODE_B)

    expect(rec.gtes).toEqual([['created_at', REQUEST_START]])
  })
})

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

describe('verifyLessonCommitted mode selection', () => {
  it('an EMPTY-STRING teamsMeetingId takes mode B, not mode A', async () => {
    // Graph failed and left an empty string rather than null. Querying
    // teams_meeting_id = '' would match nothing and wrongly report
    // not_committed on a row that exists.
    const { client, rec } = makeClient({ data: [{ id: 'lesson-12' }], error: null })

    const verdict = await verifyLessonCommitted(client, { ...BASE, teamsMeetingId: '' })

    expect(verdict.outcome).toBe('unresolved')
    if (verdict.outcome !== 'unresolved') throw new Error('narrowing')
    expect(verdict.reason).toBe('ambiguous_row')
    // Mode B fingerprints: the natural key, the IS NULL, the status exclusion.
    expect(rec.eqs.map(([column]) => column)).toEqual([
      'teacher_id',
      'student_id',
      'training_id',
      'scheduled_at',
      'duration_minutes',
    ])
    expect(rec.eqs.some(([column]) => column === 'teams_meeting_id')).toBe(false)
    expect(rec.iss).toEqual([['teams_meeting_id', null]])
    expect(rec.nots).toEqual([['status', 'in', toPostgrestInList(CANCELLED_STATUSES)]])
  })

  it('a null teamsMeetingId takes mode B', async () => {
    const { client, rec } = makeClient({ data: [], error: null })

    await verifyLessonCommitted(client, MODE_B)

    expect(rec.iss).toEqual([['teams_meeting_id', null]])
  })

  it('a non-empty teamsMeetingId takes mode A', async () => {
    const { client, rec } = makeClient({ data: [{ id: 'lesson-13' }], error: null })

    const verdict = await verifyLessonCommitted(client, BASE)

    expect(verdict).toEqual({ outcome: 'committed', lessonId: 'lesson-13' })
    expect(rec.iss).toEqual([])
    expect(rec.gtes).toEqual([])
  })
})
