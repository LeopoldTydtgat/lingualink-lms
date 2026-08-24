import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BOOK-AUDIT 1 regression net for raiseReconciliationTask.
 *
 * The helper runs inside the failure handlers of /api/student/book and
 * /api/admin/classes, two of them inside a catch block. The properties worth
 * pinning are the ones no caller can observe:
 *
 *  - it resolves rather than throwing, no matter what the database does,
 *    because a throw here converts a handled booking failure into an
 *    unhandled one on the money path;
 *  - it refuses to insert when the admin who would own the task cannot be
 *    identified unambiguously (query error, zero rows, more than one row),
 *    falling back to the log-only behaviour that existed before it;
 *  - the row it does write carries the live admin_tasks vocabulary
 *    ('open' / 'high' / 'payment') and links to the STUDENT id.
 */

// -- Fake service-role client ------------------------------------------------
// Two tables. `profiles` is the admin lookup (select -> eq -> awaited);
// `admin_tasks` takes a single awaited insert. Every call is recorded so a test
// can assert the insert did NOT happen, which is the whole point of the
// ambiguous-admin cases below.
const store = vi.hoisted(() => ({
  admins: [{ id: 'admin-1' }] as Array<{ id: unknown }> | null,
  adminError: null as { message: string } | null,
  adminSelects: [] as string[],
  adminEqs: [] as Array<[string, unknown]>,
  inserts: [] as Array<Record<string, unknown>>,
  insertError: null as { message: string } | null,
  // Simulates a service-role client that cannot even be constructed (missing
  // env var on a cold start) - the helper must still resolve.
  clientThrows: false,
}))

vi.mock('@/lib/supabase/admin', () => {
  return {
    createAdminClient: () => {
      if (store.clientThrows) throw new Error('no service role key')
      return {
        from(table: string) {
          if (table === 'admin_tasks') {
            return {
              insert(values: Record<string, unknown>) {
                store.inserts.push(values)
                return Promise.resolve({ data: null, error: store.insertError })
              },
            }
          }
          if (table !== 'profiles') {
            throw new Error(`unexpected table in test: ${table}`)
          }
          const builder = {
            select(columns: string) {
              store.adminSelects.push(columns)
              return builder
            },
            eq(column: string, value: unknown) {
              store.adminEqs.push([column, value])
              return builder
            },
            then(resolve: (r: { data: unknown; error: { message: string } | null }) => void) {
              if (store.adminError) {
                resolve({ data: null, error: store.adminError })
                return
              }
              resolve({ data: store.admins, error: null })
            },
          }
          return builder
        },
      }
    },
  }
})

import { raiseReconciliationTask } from './raiseReconciliationTask'

const INPUT = {
  studentId: 'student-1',
  trainingId: 'training-1',
  lessonId: null,
  hours: 1.5,
  context: 'refund_hours_atomic failed after lesson insert error (student booking)',
  errorDetail: { code: '42501', message: 'permission denied for function refund_hours_atomic' },
}

beforeEach(() => {
  store.admins = [{ id: 'admin-1' }]
  store.adminError = null
  store.adminSelects = []
  store.adminEqs = []
  store.inserts = []
  store.insertError = null
  store.clientThrows = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  // restoreMocks is not set in vitest.config.ts, so the console stub above
  // would otherwise outlive this file in a shared worker.
  vi.restoreAllMocks()
})

describe('raiseReconciliationTask - it can never throw', () => {
  it('resolves when the admin_tasks insert comes back with an error', async () => {
    store.insertError = { message: 'permission denied for table admin_tasks' }

    await expect(raiseReconciliationTask(INPUT)).resolves.toBeUndefined()
    // The insert was attempted; only its failure was swallowed.
    expect(store.inserts).toHaveLength(1)
  })

  it('resolves when the admin lookup comes back with an error', async () => {
    store.adminError = { message: 'connection reset' }

    await expect(raiseReconciliationTask(INPUT)).resolves.toBeUndefined()
  })

  it('resolves when the service-role client cannot be constructed', async () => {
    store.clientThrows = true

    await expect(raiseReconciliationTask(INPUT)).resolves.toBeUndefined()
    expect(store.inserts).toHaveLength(0)
  })

  it('resolves when errorDetail is a circular structure JSON cannot render', async () => {
    const circular: Record<string, unknown> = { code: 'PGRST301' }
    circular.self = circular

    await expect(
      raiseReconciliationTask({ ...INPUT, errorDetail: circular })
    ).resolves.toBeUndefined()
    expect(store.inserts).toHaveLength(1)
  })
})

describe('raiseReconciliationTask - admin resolution', () => {
  it('skips the insert when the admin lookup errors', async () => {
    store.adminError = { message: 'connection reset' }

    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(0)
  })

  it('skips the insert when no admin profile is found', async () => {
    store.admins = []

    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(0)
  })

  it('skips the insert when more than one admin profile is found', async () => {
    // Never guess which admin owns a money-path failure.
    store.admins = [{ id: 'admin-1' }, { id: 'admin-2' }]

    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(0)
  })

  it('skips the insert when the admin row has no usable id', async () => {
    store.admins = [{ id: null }]

    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(0)
  })

  it('skips the insert when PostgREST returns neither rows nor an error', async () => {
    store.admins = null

    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(0)
  })

  it('queries profiles filtered on role admin', async () => {
    await raiseReconciliationTask(INPUT)

    expect(store.adminSelects).toEqual(['id'])
    expect(store.adminEqs).toEqual([['role', 'admin']])
  })
})

describe('raiseReconciliationTask - the row it writes', () => {
  it('inserts exactly one open high-priority payment task owned by the admin', async () => {
    await raiseReconciliationTask(INPUT)

    expect(store.inserts).toHaveLength(1)
    const row = store.inserts[0]
    expect(row.status).toBe('open')
    expect(row.priority).toBe('high')
    expect(row.follow_up_reason).toBe('payment')
    expect(row.title).toBe('Reconcile student hours - booking failure')
    expect(row.assigned_to).toBe('admin-1')
    expect(row.created_by).toBe('admin-1')
  })

  it('links the task to the student id, not to a lesson or training', async () => {
    await raiseReconciliationTask(INPUT)

    const row = store.inserts[0]
    expect(row.linked_entity_type).toBe('student')
    expect(row.linked_entity_id).toBe('student-1')
  })

  it('leaves BOTH link columns null when there is no student id', async () => {
    await raiseReconciliationTask({ ...INPUT, studentId: null })

    const row = store.inserts[0]
    expect(row.linked_entity_type).toBeNull()
    expect(row.linked_entity_id).toBeNull()
  })

  it('leaves BOTH link columns null for an empty-string student id', async () => {
    // Falsy but not nullish. Two different null tests would write type null
    // alongside id '', which a uuid column rejects (22P02) - losing the task.
    await raiseReconciliationTask({ ...INPUT, studentId: '' })

    const row = store.inserts[0]
    expect(row.linked_entity_type).toBeNull()
    expect(row.linked_entity_id).toBeNull()
  })

  it('carries the context, ids, hours and error detail into notes', async () => {
    await raiseReconciliationTask({ ...INPUT, lessonId: 'lesson-9' })

    const notes = store.inserts[0].notes as string
    expect(notes).toContain(INPUT.context)
    expect(notes).toContain('training-1')
    expect(notes).toContain('lesson-9')
    expect(notes).toContain('1.5')
    // A PostgrestError must not degrade to "[object Object]" - the detail is
    // the reason the task exists.
    expect(notes).toContain('42501')
    expect(notes).not.toContain('[object Object]')
  })

  it('truncates a runaway error payload instead of writing it whole', async () => {
    await raiseReconciliationTask({ ...INPUT, errorDetail: 'x'.repeat(5000) })

    const notes = store.inserts[0].notes as string
    expect(notes).toContain('... (truncated)')
    expect(notes.length).toBeLessThan(1000)
  })
})
