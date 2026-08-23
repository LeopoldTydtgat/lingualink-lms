import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GCAL REBUILD 2 regression net for deleteLessonGoogleEvent (step 4) and
 * updateLessonGoogleEvent (step 5b).
 *
 * Both helpers run after their caller's database change has already committed,
 * so the properties worth pinning are the ones a caller can never observe: that
 * the no-pointer cases cost Google nothing at all, that the pointer is written
 * or cleared ONLY when Google has confirmed the write, and that a failure
 * anywhere in here stays a log line instead of a thrown error.
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
  createCalls: [] as Array<{
    accessToken: string
    summary: string
    startIso: string
    endIso: string
    timezone: string
  }>,
  createResult: { ok: true, eventId: 'evt-new' } as
    | { ok: true; eventId: string }
    | { ok: false; error: string },
  updateEventCalls: [] as Array<{
    accessToken: string
    eventId: string
    startIso: string
    endIso: string
    timezone: string
  }>,
  updateEventResult: { ok: true } as { ok: true } | { ok: false; error: string },
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
  createGoogleEvent: (options: {
    accessToken: string
    summary: string
    startIso: string
    endIso: string
    timezone: string
  }) => {
    store.createCalls.push(options)
    return Promise.resolve(store.createResult)
  },
  updateGoogleEvent: (options: {
    accessToken: string
    eventId: string
    startIso: string
    endIso: string
    timezone: string
  }) => {
    store.updateEventCalls.push(options)
    return Promise.resolve(store.updateEventResult)
  },
  deleteGoogleEvent: (options: { accessToken: string; eventId: string }) => {
    store.deleteCalls.push(options)
    return Promise.resolve(store.deleteResult)
  },
}))

// Import AFTER the mocks are registered.
import { deleteLessonGoogleEvent, updateLessonGoogleEvent } from './lessonEvents'

const LESSON_ID = 'lesson-1'
// One hour, chosen so the end instant is obvious by eye in every assertion.
const NEW_START_ISO = '2026-09-01T10:00:00.000Z'
const NEW_END_ISO = '2026-09-01T11:00:00.000Z'
const NEW_DURATION = 60

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

describe('updateLessonGoogleEvent', () => {
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
    store.createCalls = []
    store.createResult = { ok: true, eventId: 'evt-new' }
    store.updateEventCalls = []
    store.updateEventResult = { ok: true }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves the stored event and leaves the pointer alone', async () => {
    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    expect(store.updateEventCalls).toEqual([
      {
        accessToken: 'access-token-abc',
        eventId: 'evt-123',
        startIso: NEW_START_ISO,
        endIso: NEW_END_ISO,
        timezone: 'UTC',
      },
    ])
    // The event id has not changed, so there is nothing to write back - and a
    // create here would put a SECOND block on her calendar for one class.
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    // Explicit column lists on both reads — no select('*') on lessons.
    expect(store.lessonSelects).toEqual(['id, google_event_id'])
    expect(store.connectionSelects).toEqual(['id, refresh_token'])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('keeps the pointer when Google refuses the move', async () => {
    store.updateEventResult = { ok: false, error: 'Google Calendar returned HTTP 404' }

    await expect(
      updateLessonGoogleEvent({
        lessonId: LESSON_ID,
        studentName: 'Marta Ruiz',
        scheduledAtIso: NEW_START_ISO,
        durationMinutes: NEW_DURATION,
      })
    ).resolves.toBeUndefined()

    expect(store.updateEventCalls).toHaveLength(1)
    // The block is still sitting at its OLD time and this id is the only handle
    // on it. Nulling it would strand it there permanently.
    expect(store.updates).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('creates the block and persists the new id when the lesson has no pointer', async () => {
    store.lesson = { id: LESSON_ID, google_event_id: null }

    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([
      {
        accessToken: 'access-token-abc',
        // First name only, from the one shared title builder.
        summary: 'English class - Marta',
        startIso: NEW_START_ISO,
        endIso: NEW_END_ISO,
        timezone: 'UTC',
      },
    ])
    expect(store.updates).toEqual([
      {
        values: { google_event_id: 'evt-new' },
        eqs: [['id', LESSON_ID]],
        returning: ['id'],
      },
    ])
  })

  it('creates the block when the stored event id is blank', async () => {
    store.lesson = { id: LESSON_ID, google_event_id: '   ' }

    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toHaveLength(1)
    expect(store.updates).toHaveLength(1)
  })

  it('makes no Google request at all when the timing is unusable', async () => {
    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: 'not-a-date',
      durationMinutes: NEW_DURATION,
    })

    // The guard sits above the lesson read, so not even the database is
    // touched: new Date(NaN).toISOString() would otherwise throw only after a
    // read and a token refresh had been spent on it.
    expect(store.lessonSelects).toEqual([])
    expect(store.connectionSelects).toEqual([])
    expect(store.refreshCalls).toEqual([])
    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('makes no Google request when the duration is not a positive number', async () => {
    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: 0,
    })

    expect(store.lessonSelects).toEqual([])
    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([])
  })

  it('does not throw and makes no Google request when the lesson row is gone', async () => {
    store.lesson = null

    await expect(
      updateLessonGoogleEvent({
        lessonId: LESSON_ID,
        studentName: 'Marta Ruiz',
        scheduledAtIso: NEW_START_ISO,
        durationMinutes: NEW_DURATION,
      })
    ).resolves.toBeUndefined()

    expect(store.refreshCalls).toEqual([])
    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    // A missing row straight after a successful edit IS anomalous — logged.
    expect(console.error).toHaveBeenCalled()
  })

  it('does not throw when the create-if-missing pointer UPDATE errors', async () => {
    store.lesson = { id: LESSON_ID, google_event_id: null }
    store.updateError = { message: 'update exploded' }

    await expect(
      updateLessonGoogleEvent({
        lessonId: LESSON_ID,
        studentName: 'Marta Ruiz',
        scheduledAtIso: NEW_START_ISO,
        durationMinutes: NEW_DURATION,
      })
    ).resolves.toBeUndefined()

    expect(store.createCalls).toHaveLength(1)
    expect(store.updates).toHaveLength(1)
    expect(console.error).toHaveBeenCalled()
  })
})
