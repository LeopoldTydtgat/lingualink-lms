import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GCAL REBUILD 2 step 4 regression net for deleteLessonGoogleEvent.
 *
 * The helper runs on all three cancel paths after the cancellation has already
 * committed, so the properties worth pinning are the ones a caller can never
 * observe: that the no-pointer case costs Google nothing at all, that the
 * pointer is cleared ONLY once Google has confirmed the delete, and that a
 * failure anywhere in here stays a log line instead of a thrown error.
 */

// -- Fake service-role client ------------------------------------------------
// Two tables. `lessons` serves both the pointer read (select -> eq ->
// maybeSingle) and the pointer clear (update -> eq -> select), distinguished by
// whether update() has been called; `google_calendar_connections` is a plain
// awaited select. Every read is recorded so a test can assert a round trip did
// NOT happen, which is the whole point of the first case below.
const store = vi.hoisted(() => ({
  lesson: null as { id: string; google_event_id: string | null } | null,
  lessonError: null as { message: string } | null,
  lessonSelects: [] as string[],
  connections: [] as Array<{ id: string; refresh_token: string }>,
  connectionSelects: [] as string[],
  updates: [] as Array<{ values: Record<string, unknown>; eqs: Array<[string, unknown]>; returning: string[] }>,
  updateError: null as { message: string } | null,
  updateRows: [{ id: 'lesson-1' }] as Array<{ id: string }> | null,
  refreshCalls: [] as string[],
  deleteCalls: [] as Array<{ accessToken: string; eventId: string }>,
  deleteResult: { ok: true } as { ok: true } | { ok: false; error: string },
}))

vi.mock('@/lib/supabase/admin', () => {
  return {
    createAdminClient: () => ({
      from(table: string) {
        if (table !== 'lessons' && table !== 'google_calendar_connections') {
          throw new Error(`unexpected table in test: ${table}`)
        }
        let mutation: Record<string, unknown> | null = null
        const eqs: Array<[string, unknown]> = []
        const returning: string[] = []
        const builder = {
          select(columns: string) {
            // After update() this is PostgREST's return-representation clause,
            // not a read — recorded separately so the two cannot be confused.
            if (mutation) returning.push(columns)
            else if (table === 'lessons') store.lessonSelects.push(columns)
            else store.connectionSelects.push(columns)
            return builder
          },
          update(values: Record<string, unknown>) {
            mutation = values
            return builder
          },
          eq(column: string, value: unknown) {
            eqs.push([column, value])
            return builder
          },
          maybeSingle() {
            if (table !== 'lessons') {
              throw new Error(`unexpected maybeSingle on ${table}`)
            }
            return Promise.resolve(
              store.lessonError
                ? { data: null, error: store.lessonError }
                : { data: store.lesson, error: null }
            )
          },
          // Awaiting the builder runs it: a mutation applies, anything else is
          // the connections read.
          then(
            resolve: (r: { data: unknown; error: { message: string } | null }) => void
          ) {
            if (mutation) {
              store.updates.push({ values: mutation, eqs: [...eqs], returning: [...returning] })
              if (store.updateError) {
                resolve({ data: null, error: store.updateError })
                return
              }
              resolve({ data: store.updateRows, error: null })
              return
            }
            if (table !== 'google_calendar_connections') {
              throw new Error(`unexpected awaited select on ${table}`)
            }
            resolve({ data: store.connections, error: null })
          },
        }
        return builder
      },
    }),
  }
})

vi.mock('@/lib/google/oauth', () => ({
  refreshGoogleAccessToken: (refreshToken: string) => {
    store.refreshCalls.push(refreshToken)
    return Promise.resolve({
      outcome: 'refreshed' as const,
      accessToken: 'access-token-abc',
      expiresAtIso: '2026-08-23T12:00:00.000Z',
      error: null,
    })
  },
}))

vi.mock('@/lib/google/calendar', () => ({
  // Imported by the module under test; unused on the delete path.
  createGoogleEvent: vi.fn(),
  deleteGoogleEvent: (options: { accessToken: string; eventId: string }) => {
    store.deleteCalls.push(options)
    return Promise.resolve(store.deleteResult)
  },
}))

// Import AFTER the mocks are registered.
import { deleteLessonGoogleEvent } from './lessonEvents'

const LESSON_ID = 'lesson-1'

describe('deleteLessonGoogleEvent', () => {
  beforeEach(() => {
    store.lesson = { id: LESSON_ID, google_event_id: 'evt-123' }
    store.lessonError = null
    store.lessonSelects = []
    store.connections = [{ id: 'conn-1', refresh_token: 'refresh-abc' }]
    store.connectionSelects = []
    store.updates = []
    store.updateError = null
    store.updateRows = [{ id: LESSON_ID }]
    store.refreshCalls = []
    store.deleteCalls = []
    store.deleteResult = { ok: true }
    // console.error is this module's only failure channel and several cases
    // drive it on purpose; silencing keeps the run readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('makes no Google request at all when the lesson carries no event id', async () => {
    store.lesson = { id: LESSON_ID, google_event_id: null }

    await deleteLessonGoogleEvent(LESSON_ID)

    // Not just "no delete": the connection lookup and the token refresh must
    // not happen either. This path runs on every cancellation of every lesson
    // booked before the feature existed.
    expect(store.connectionSelects).toEqual([])
    expect(store.refreshCalls).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
    // And it is silent — a log line here would be pure noise.
    expect(console.error).not.toHaveBeenCalled()
  })

  it('makes no Google request when the event id is blank', async () => {
    store.lesson = { id: LESSON_ID, google_event_id: '   ' }

    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.connectionSelects).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
  })

  it('deletes the stored event and then nulls the pointer', async () => {
    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.deleteCalls).toEqual([{ accessToken: 'access-token-abc', eventId: 'evt-123' }])
    expect(store.updates).toEqual([
      {
        values: { google_event_id: null },
        eqs: [['id', LESSON_ID]],
        returning: ['id'],
      },
    ])
    // Explicit column lists on both reads — no select('*') on lessons.
    expect(store.lessonSelects).toEqual(['id, google_event_id'])
    expect(store.connectionSelects).toEqual(['id, refresh_token'])
  })

  it('keeps the pointer when Google refuses the delete', async () => {
    store.deleteResult = { ok: false, error: 'Google Calendar returned HTTP 500' }

    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.deleteCalls).toHaveLength(1)
    // The block is still on the calendar and this id is the only handle on it.
    expect(store.updates).toEqual([])
  })

  it('does not throw when the pointer UPDATE errors', async () => {
    store.updateError = { message: 'update exploded' }

    await expect(deleteLessonGoogleEvent(LESSON_ID)).resolves.toBeUndefined()

    expect(store.deleteCalls).toHaveLength(1)
    expect(store.updates).toHaveLength(1)
    expect(console.error).toHaveBeenCalled()
  })

  it('does not throw when the pointer UPDATE matches no row', async () => {
    store.updateRows = []

    await expect(deleteLessonGoogleEvent(LESSON_ID)).resolves.toBeUndefined()

    expect(console.error).toHaveBeenCalled()
  })

  it('does not throw and makes no Google request when the lesson row is gone', async () => {
    store.lesson = null

    await expect(deleteLessonGoogleEvent(LESSON_ID)).resolves.toBeUndefined()

    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
    // A missing row straight after a successful cancel IS anomalous — logged.
    expect(console.error).toHaveBeenCalled()
  })

  it('makes no Google request when more than one calendar is connected', async () => {
    store.connections = [
      { id: 'conn-1', refresh_token: 'refresh-abc' },
      { id: 'conn-2', refresh_token: 'refresh-def' },
    ]

    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.refreshCalls).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
  })

  it('makes no Google request when no calendar is connected', async () => {
    store.connections = []

    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.refreshCalls).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(console.error).not.toHaveBeenCalled()
  })
})
