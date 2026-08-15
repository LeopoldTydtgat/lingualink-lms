import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * BOOK-RATELIMIT-CHARGES-REJECTS regression net for the student booking limiter.
 *
 * The bug class: checkStudentBookingLimit used to COUNT and INSERT in one call
 * at the top of /api/student/book, so budget was spent before any validation
 * ran — ten stale-grid 409s locked an honest student out for an hour. The
 * limiter is now two phases: checkStudentBookingLimit counts (and must write
 * NOTHING), recordStudentBookingAttempt inserts (and must fail closed so the
 * route can abort before the money RPC). These tests pin both halves.
 */

// -- Fake service-role client ------------------------------------------------
// booking_attempts only. The select builder accumulates the same filters the
// limiter chains (eq / gte / order) and applies them on await, so the real
// window arithmetic and student scoping are exercised rather than stubbed.
// insert() appends a row unless the harness is armed to error or throw.
const store = vi.hoisted(() => ({
  rows: [] as Array<{ student_id: string; attempted_at: string }>,
  selectError: null as { message: string } | null,
  selectThrows: false,
  insertError: null as { message: string } | null,
  insertThrows: false,
  inserts: 0,
}))

vi.mock('@/lib/supabase/admin', () => {
  type Row = { student_id: string; attempted_at: string }
  return {
    createAdminClient: () => ({
      from(table: string) {
        if (table !== 'booking_attempts') {
          throw new Error(`unexpected table in test: ${table}`)
        }
        const preds: Array<(row: Row) => boolean> = []
        let ascending = true
        const builder = {
          // Also pins the explicit column list — no select('*') on this table.
          select(columns: string) {
            if (columns !== 'attempted_at') {
              throw new Error(`unexpected select in test: ${columns}`)
            }
            return builder
          },
          eq(column: keyof Row, value: string) {
            preds.push((row: Row) => row[column] === value)
            return builder
          },
          gte(column: keyof Row, value: string) {
            // ISO-8601 UTC strings compare correctly lexicographically.
            preds.push((row: Row) => row[column] >= value)
            return builder
          },
          order(column: keyof Row, opts: { ascending: boolean }) {
            if (column !== 'attempted_at') {
              throw new Error(`unexpected order in test: ${column}`)
            }
            ascending = opts.ascending
            return builder
          },
          insert(values: { student_id: string }) {
            store.inserts++
            if (store.insertThrows) throw new Error('insert exploded')
            if (store.insertError) return Promise.resolve({ error: store.insertError })
            store.rows.push({
              student_id: values.student_id,
              attempted_at: new Date().toISOString(),
            })
            return Promise.resolve({ error: null })
          },
          // Awaiting the builder runs the accumulated filters, mirroring a
          // PostgREST chained SELECT.
          then(
            resolve: (r: { data: Row[] | null; error: { message: string } | null }) => void
          ) {
            if (store.selectThrows) throw new Error('select exploded')
            if (store.selectError) {
              resolve({ data: null, error: store.selectError })
              return
            }
            const rows = store.rows
              .filter((row) => preds.every((p) => p(row)))
              .sort((a, b) =>
                ascending
                  ? a.attempted_at.localeCompare(b.attempted_at)
                  : b.attempted_at.localeCompare(a.attempted_at)
              )
            resolve({ data: rows, error: null })
          },
        }
        return builder
      },
    }),
  }
})

// Import AFTER the mock is registered.
import { checkStudentBookingLimit, recordStudentBookingAttempt } from './rateLimit'

const STUDENT = 'student-1'
const OTHER_STUDENT = 'student-2'
const HOUR_MS = 60 * 60 * 1000

// n attempts, the oldest `oldestMinutesAgo` minutes back, the rest newer.
function seed(studentId: string, n: number, oldestMinutesAgo: number) {
  const oldestMs = Date.now() - oldestMinutesAgo * 60 * 1000
  for (let i = 0; i < n; i++) {
    store.rows.push({
      student_id: studentId,
      attempted_at: new Date(oldestMs + i * 1000).toISOString(),
    })
  }
}

beforeEach(() => {
  store.rows = []
  store.selectError = null
  store.selectThrows = false
  store.insertError = null
  store.insertThrows = false
  store.inserts = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkStudentBookingLimit (phase 1 — count only)', () => {
  it('writes nothing: a passing check leaves booking_attempts untouched', async () => {
    seed(STUDENT, 3, 10)

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res).toEqual({ blocked: false, retryAfterSeconds: 0 })
    // The whole point of the split — no budget is spent by the check itself.
    expect(store.inserts).toBe(0)
    expect(store.rows).toHaveLength(3)
  })

  it('writes nothing even when it blocks', async () => {
    seed(STUDENT, 10, 10)

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res.blocked).toBe(true)
    expect(store.inserts).toBe(0)
    expect(store.rows).toHaveLength(10)
  })

  it('blocks at the cap and reports when the oldest attempt leaves the window', async () => {
    seed(STUDENT, 10, 10)

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res.blocked).toBe(true)
    // Oldest attempt is 10 min old, window is 60 min, so ~50 min remain.
    expect(res.retryAfterSeconds).toBeGreaterThan(2900)
    expect(res.retryAfterSeconds).toBeLessThanOrEqual(50 * 60)
  })

  it('ignores attempts older than the 60-minute window', async () => {
    seed(STUDENT, 10, 120)

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res).toEqual({ blocked: false, retryAfterSeconds: 0 })
  })

  it('counts only the requested student', async () => {
    seed(OTHER_STUDENT, 10, 10)
    seed(STUDENT, 1, 10)

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res).toEqual({ blocked: false, retryAfterSeconds: 0 })
  })

  it('fails closed on a read error', async () => {
    store.selectError = { message: 'db down' }

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res).toEqual({ blocked: true, retryAfterSeconds: 60 })
    expect(store.inserts).toBe(0)
  })

  it('fails closed when the read throws', async () => {
    store.selectThrows = true

    const res = await checkStudentBookingLimit(STUDENT)

    expect(res).toEqual({ blocked: true, retryAfterSeconds: 60 })
  })
})

describe('recordStudentBookingAttempt (phase 2 — insert only)', () => {
  it('records exactly one attempt and returns ok', async () => {
    const res = await recordStudentBookingAttempt(STUDENT)

    expect(res).toEqual({ ok: true })
    expect(store.inserts).toBe(1)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].student_id).toBe(STUDENT)
  })

  it('returns { ok: false } on insert error', async () => {
    store.insertError = { message: 'permission denied' }

    const res = await recordStudentBookingAttempt(STUDENT)

    // Fail closed: the route must abort before the money RPC on this.
    expect(res).toEqual({ ok: false })
    expect(store.rows).toHaveLength(0)
  })

  it('returns { ok: false } when the insert throws', async () => {
    store.insertThrows = true

    const res = await recordStudentBookingAttempt(STUDENT)

    expect(res).toEqual({ ok: false })
    expect(store.rows).toHaveLength(0)
  })

  it('does not count: it never blocks, even past the cap', async () => {
    seed(STUDENT, 20, 10)

    const res = await recordStudentBookingAttempt(STUDENT)

    expect(res).toEqual({ ok: true })
    expect(store.rows).toHaveLength(21)
  })
})

describe('the two phases together', () => {
  it('spends budget only when an attempt is recorded', async () => {
    // Ten checks (e.g. ten stale-grid 409s that never reach a money RPC)
    // leave the student's budget untouched...
    for (let i = 0; i < 10; i++) {
      const res = await checkStudentBookingLimit(STUDENT)
      expect(res.blocked).toBe(false)
    }
    expect(store.rows).toHaveLength(0)

    // ...whereas ten requests that reach the RPC do fill the window.
    for (let i = 0; i < 10; i++) {
      expect(await recordStudentBookingAttempt(STUDENT)).toEqual({ ok: true })
    }
    expect(store.rows).toHaveLength(10)
    expect((await checkStudentBookingLimit(STUDENT)).blocked).toBe(true)
  })

  it('a recorded attempt still ages out of the window', async () => {
    seed(STUDENT, 10, 61)
    expect((await checkStudentBookingLimit(STUDENT)).blocked).toBe(false)

    // Sanity: the same rows one minute inside the window do block.
    store.rows = []
    seed(STUDENT, 10, 59)
    expect((await checkStudentBookingLimit(STUDENT)).blocked).toBe(true)
  })
})

// Guards the fixture helper itself: `seed` must place rows inside/outside the
// window as advertised, otherwise the window tests above would pass vacuously.
describe('fixture sanity', () => {
  it('seeds rows at the requested age', () => {
    seed(STUDENT, 1, 30)
    const age = Date.now() - new Date(store.rows[0].attempted_at).getTime()
    expect(age).toBeGreaterThan(29 * 60 * 1000)
    expect(age).toBeLessThan(HOUR_MS)
  })
})
