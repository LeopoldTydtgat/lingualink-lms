import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GCAL REBUILD 2 regression net for createLessonGoogleEvent (step 3),
 * deleteLessonGoogleEvent (step 4) and updateLessonGoogleEvent (step 5b),
 * including the ownership correction that scopes every write to the LESSON'S
 * OWN TEACHER.
 *
 * All three helpers run after their caller's database change has already
 * committed, so the properties worth pinning are the ones a caller can never
 * observe: that a lesson whose teacher has not connected a calendar costs
 * Google nothing at all, that the no-pointer cases cost Google nothing either,
 * that the pointer is written or cleared ONLY when Google has confirmed the
 * write, and that a failure anywhere in here stays a log line instead of a
 * thrown error.
 */

// -- Fake service-role client ------------------------------------------------
// Two tables. `lessons` serves both the pointer read (select -> eq ->
// maybeSingle) and the pointer clear (update -> eq -> select), distinguished by
// whether update() has been called; `google_calendar_connections` is a plain
// awaited select, now FILTERED on profile_id. Every read is recorded so a test
// can assert a round trip did NOT happen, which is the whole point of the
// ownership cases below.
const store = vi.hoisted(() => ({
  lesson: null as {
    id: string
    teacher_id: string | null
    google_event_id: string | null
  } | null,
  lessonError: null as { message: string } | null,
  lessonSelects: [] as string[],
  connections: [] as Array<{ id: string; profile_id: string; refresh_token: string }>,
  connectionSelects: [] as string[],
  // One entry per connections read, holding that read's .eq() filters. This is
  // how a test proves the query was scoped to the right teacher.
  connectionEqs: [] as Array<Array<[string, unknown]>>,
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
            store.connectionEqs.push([...eqs])
            // The real query is FILTERED on profile_id. A fake that ignored the
            // filter would hand back the one connected calendar for every
            // teacher on the platform — which is exactly the defect the filter
            // exists to remove, so the fake has to honour it.
            const rows = store.connections.filter((row) =>
              eqs.every(
                ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value
              )
            )
            resolve({ data: rows, error: null })
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
      // One access token per refresh token, so a swap assertion can tell WHOSE
      // calendar a request went to. 'refresh-abc' keeps the exact value every
      // pre-existing assertion in this file was written against.
      accessToken:
        refreshToken === 'refresh-abc' ? 'access-token-abc' : `access-token-${refreshToken}`,
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
import {
  createLessonGoogleEvent,
  deleteLessonGoogleEvent,
  updateLessonGoogleEvent,
} from './lessonEvents'

const LESSON_ID = 'lesson-1'
// The teacher who owns the lesson in the default fixture, and the connection
// row that belongs to her. OTHER_TEACHER_ID never has a connection: it is the
// "somebody else's class" side of every ownership case.
const TEACHER_ID = 'teacher-1'
const OTHER_TEACHER_ID = 'teacher-2'
// One hour, chosen so the end instant is obvious by eye in every assertion.
const NEW_START_ISO = '2026-09-01T10:00:00.000Z'
const NEW_END_ISO = '2026-09-01T11:00:00.000Z'
const NEW_DURATION = 60

describe('createLessonGoogleEvent', () => {
  beforeEach(() => {
    store.connections = [{ id: 'conn-1', profile_id: TEACHER_ID, refresh_token: 'refresh-abc' }]
    store.connectionSelects = []
    store.connectionEqs = []
    store.updates = []
    store.updateError = null
    store.updateRows = [{ id: LESSON_ID }]
    store.refreshCalls = []
    store.createCalls = []
    store.createResult = { ok: true, eventId: 'evt-new' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scopes the connection lookup to the lesson teacher and stores the new event id', async () => {
    await createLessonGoogleEvent({
      lessonId: LESSON_ID,
      teacherId: TEACHER_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    // The teacherId the caller handed in IS the filter. That single .eq() is
    // the entire ownership guarantee, so it is asserted on the query itself
    // rather than inferred from the outcome.
    expect(store.connectionEqs).toEqual([[['profile_id', TEACHER_ID]]])
    expect(store.connectionSelects).toEqual(['id, refresh_token'])
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
    expect(console.error).not.toHaveBeenCalled()
  })

  it('makes no Google request when the lesson teacher has no connection row', async () => {
    // The one connected calendar belongs to TEACHER_ID; this class is taught by
    // somebody else. Before the profile_id filter this booking would have been
    // written onto her calendar.
    await createLessonGoogleEvent({
      lessonId: LESSON_ID,
      teacherId: OTHER_TEACHER_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    expect(store.connectionEqs).toEqual([[['profile_id', OTHER_TEACHER_ID]]])
    expect(store.refreshCalls).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    // Silent: a teacher who has not connected a calendar is the normal case.
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('deleteLessonGoogleEvent', () => {
  beforeEach(() => {
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: 'evt-123' }
    store.lessonError = null
    store.lessonSelects = []
    store.connections = [{ id: 'conn-1', profile_id: TEACHER_ID, refresh_token: 'refresh-abc' }]
    store.connectionSelects = []
    store.connectionEqs = []
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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: null }

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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: '   ' }

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
    expect(store.lessonSelects).toEqual(['id, teacher_id, google_event_id'])
    expect(store.connectionSelects).toEqual(['id, refresh_token'])
    // Scoped to the teacher read off the lesson row, never to "the one
    // connection that exists".
    expect(store.connectionEqs).toEqual([[['profile_id', TEACHER_ID]]])
  })

  it('makes no Google request when the lesson teacher has no connection row', async () => {
    // The connected calendar belongs to TEACHER_ID; this class is somebody
    // else's, so her calendar must not be touched by its cancellation.
    store.lesson = { id: LESSON_ID, teacher_id: OTHER_TEACHER_ID, google_event_id: 'evt-123' }

    await deleteLessonGoogleEvent(LESSON_ID)

    expect(store.connectionEqs).toEqual([[['profile_id', OTHER_TEACHER_ID]]])
    expect(store.refreshCalls).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(console.error).not.toHaveBeenCalled()
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
      { id: 'conn-1', profile_id: TEACHER_ID, refresh_token: 'refresh-abc' },
      { id: 'conn-2', profile_id: TEACHER_ID, refresh_token: 'refresh-def' },
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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: 'evt-123' }
    store.lessonError = null
    store.lessonSelects = []
    store.connections = [{ id: 'conn-1', profile_id: TEACHER_ID, refresh_token: 'refresh-abc' }]
    store.connectionSelects = []
    store.connectionEqs = []
    store.updates = []
    store.updateError = null
    store.updateRows = [{ id: LESSON_ID }]
    store.refreshCalls = []
    store.createCalls = []
    store.createResult = { ok: true, eventId: 'evt-new' }
    store.updateEventCalls = []
    store.updateEventResult = { ok: true }
    // The swap branch deletes the outgoing owner's event, so this helper now
    // reaches deleteGoogleEvent too and both must be reset here.
    store.deleteCalls = []
    store.deleteResult = { ok: true }
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
    expect(store.lessonSelects).toEqual(['id, teacher_id, google_event_id'])
    expect(store.connectionSelects).toEqual(['id, refresh_token'])
    // Scoped to the lesson's own teacher, read off the row.
    expect(store.connectionEqs).toEqual([[['profile_id', TEACHER_ID]]])
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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: null }

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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: '   ' }

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
    store.lesson = { id: LESSON_ID, teacher_id: TEACHER_ID, google_event_id: null }
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

  it('makes no Google request when the lesson teacher has no connection row', async () => {
    // The connected calendar belongs to TEACHER_ID; this class is somebody
    // else's, so editing it must not touch her calendar at all.
    store.lesson = { id: LESSON_ID, teacher_id: OTHER_TEACHER_ID, google_event_id: 'evt-123' }

    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
    })

    expect(store.connectionEqs).toEqual([[['profile_id', OTHER_TEACHER_ID]]])
    expect(store.refreshCalls).toEqual([])
    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('behaves exactly as the no-swap path when previousTeacherId equals the current teacher', async () => {
    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
      previousTeacherId: TEACHER_ID,
    })

    // Same teacher in and out: this is a plain move, not a handover.
    expect(store.updateEventCalls).toEqual([
      {
        accessToken: 'access-token-abc',
        eventId: 'evt-123',
        startIso: NEW_START_ISO,
        endIso: NEW_END_ISO,
        timezone: 'UTC',
      },
    ])
    expect(store.createCalls).toEqual([])
    expect(store.deleteCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(store.connectionEqs).toEqual([[['profile_id', TEACHER_ID]]])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('on a teacher swap creates for the new owner, rewrites the pointer, then deletes the old block with the previous owner token', async () => {
    // The class has moved from TEACHER_ID to OTHER_TEACHER_ID, and both have
    // connected a calendar.
    store.lesson = { id: LESSON_ID, teacher_id: OTHER_TEACHER_ID, google_event_id: 'evt-123' }
    store.connections = [
      { id: 'conn-1', profile_id: TEACHER_ID, refresh_token: 'refresh-abc' },
      { id: 'conn-2', profile_id: OTHER_TEACHER_ID, refresh_token: 'refresh-new' },
    ]

    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
      previousTeacherId: TEACHER_ID,
    })

    // 1. A fresh block on the NEW owner's calendar, at the new times, under her
    //    own token. Never updateGoogleEvent: her calendar has no such event.
    expect(store.updateEventCalls).toEqual([])
    expect(store.createCalls).toEqual([
      {
        accessToken: 'access-token-refresh-new',
        summary: 'English class - Marta',
        startIso: NEW_START_ISO,
        endIso: NEW_END_ISO,
        timezone: 'UTC',
      },
    ])
    // 2. The pointer now names the new owner's event, and is written exactly
    //    once - the old-block delete must NOT null it afterwards.
    expect(store.updates).toEqual([
      {
        values: { google_event_id: 'evt-new' },
        eqs: [['id', LESSON_ID]],
        returning: ['id'],
      },
    ])
    // 3. The old block comes off the PREVIOUS owner's calendar, by the id held
    //    in memory across the pointer overwrite, under the previous owner's own
    //    token.
    expect(store.deleteCalls).toEqual([
      { accessToken: 'access-token-abc', eventId: 'evt-123' },
    ])
    // New owner resolved first, previous owner second - the create-first order.
    expect(store.connectionEqs).toEqual([
      [['profile_id', OTHER_TEACHER_ID]],
      [['profile_id', TEACHER_ID]],
    ])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('on a teacher swap to an unconnected teacher creates nothing, deletes the old block and nulls the pointer', async () => {
    // Only the OUTGOING teacher has a calendar. Her block still has to come off
    // it: she no longer teaches this class.
    store.lesson = { id: LESSON_ID, teacher_id: OTHER_TEACHER_ID, google_event_id: 'evt-123' }

    await updateLessonGoogleEvent({
      lessonId: LESSON_ID,
      studentName: 'Marta Ruiz',
      scheduledAtIso: NEW_START_ISO,
      durationMinutes: NEW_DURATION,
      previousTeacherId: TEACHER_ID,
    })

    expect(store.createCalls).toEqual([])
    expect(store.updateEventCalls).toEqual([])
    expect(store.deleteCalls).toEqual([
      { accessToken: 'access-token-abc', eventId: 'evt-123' },
    ])
    // No replacement event exists, so the pointer must not keep naming the one
    // that was just deleted.
    expect(store.updates).toEqual([
      {
        values: { google_event_id: null },
        eqs: [['id', LESSON_ID]],
        returning: ['id'],
      },
    ])
    expect(store.connectionEqs).toEqual([
      [['profile_id', OTHER_TEACHER_ID]],
      [['profile_id', TEACHER_ID]],
    ])
  })

  it('on a teacher swap leaves the pointer untouched when the old block will not delete', async () => {
    store.lesson = { id: LESSON_ID, teacher_id: OTHER_TEACHER_ID, google_event_id: 'evt-123' }
    store.deleteResult = { ok: false, error: 'Google Calendar returned HTTP 500' }

    await expect(
      updateLessonGoogleEvent({
        lessonId: LESSON_ID,
        studentName: 'Marta Ruiz',
        scheduledAtIso: NEW_START_ISO,
        durationMinutes: NEW_DURATION,
        previousTeacherId: TEACHER_ID,
      })
    ).resolves.toBeUndefined()

    expect(store.deleteCalls).toHaveLength(1)
    // The new owner is not connected, so step 1 wrote no replacement pointer.
    // The stale block is still on the outgoing teacher's calendar and this id
    // is the only handle on it, so the row must keep naming it.
    expect(store.createCalls).toEqual([])
    expect(store.updates).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })
})
