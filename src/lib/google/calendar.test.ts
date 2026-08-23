import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBusyIntervals,
  createGoogleEvent,
  deleteGoogleEvent,
  fetchGoogleCalendarEvents,
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  mergeIntervalsWithinLocalDays,
  splitAtLocalMidnights,
  updateGoogleEvent,
  type GoogleCalendarEvent,
} from './calendar'
import { getLocalDateKey } from '@/lib/utils/timezone'

// The connected profile's timezone drives every local-day decision in the sync.
const TZ = 'Europe/Madrid'
const ORGANISER = 'Admin@LingualinkOnline.onmicrosoft.com'

// A window wide enough that clamping never interferes with the cases under
// test; the clamp itself is exercised by its own test below.
const WINDOW_START = Date.parse('2026-09-01T00:00:00.000Z')
const WINDOW_END = Date.parse('2026-10-31T00:00:00.000Z')

// "This teacher has no class blocks on this calendar" - the state every case
// below assumes unless it is testing the id echo filter itself. Frozen into a
// constant so no case can mutate it for another.
const NO_CLASS_EVENTS: ReadonlySet<string> = new Set<string>()

function event(overrides: Partial<GoogleCalendarEvent>): GoogleCalendarEvent {
  return {
    id: 'evt',
    status: 'confirmed',
    organizer: { email: 'someone.else@example.com' },
    start: { dateTime: '2026-09-10T09:00:00+02:00' },
    end: { dateTime: '2026-09-10T10:00:00+02:00' },
    ...overrides,
  }
}

function build(events: GoogleCalendarEvent[], classEventIds: Set<string> = new Set()) {
  return buildBusyIntervals(events, {
    timezone: TZ,
    organiserEmail: ORGANISER,
    classEventIds,
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
  })
}

const iso = (ms: number) => new Date(ms).toISOString()

describe('splitAtLocalMidnights', () => {
  it('splits an event crossing local midnight into one interval per local day', () => {
    // 22:00 -> 02:00 Madrid time (CEST, UTC+2) on the night of 10-11 Sept 2026.
    const startMs = Date.parse('2026-09-10T22:00:00+02:00')
    const endMs = Date.parse('2026-09-11T02:00:00+02:00')

    const segments = splitAtLocalMidnights({ startMs, endMs }, TZ)

    expect(segments.map((s) => [iso(s.startMs), iso(s.endMs)])).toEqual([
      // 10 Sept, 22:00 -> 24:00 Madrid
      ['2026-09-10T20:00:00.000Z', '2026-09-10T22:00:00.000Z'],
      // 11 Sept, 00:00 -> 02:00 Madrid
      ['2026-09-10T22:00:00.000Z', '2026-09-11T00:00:00.000Z'],
    ])
  })

  it('leaves a same-day event as a single interval', () => {
    const startMs = Date.parse('2026-09-10T09:00:00+02:00')
    const endMs = Date.parse('2026-09-10T10:30:00+02:00')

    expect(splitAtLocalMidnights({ startMs, endMs }, TZ)).toEqual([{ startMs, endMs }])
  })

  it('does not split an event ending exactly at local midnight', () => {
    // The renderer's cross-midnight clamp lands on this row's true end, so one
    // row is correct here.
    const startMs = Date.parse('2026-09-10T22:00:00+02:00')
    const endMs = Date.parse('2026-09-11T00:00:00+02:00')

    expect(splitAtLocalMidnights({ startMs, endMs }, TZ)).toEqual([{ startMs, endMs }])
  })

  it('splits a multi-day event into one interval per day it touches', () => {
    const startMs = Date.parse('2026-09-10T09:00:00+02:00')
    const endMs = Date.parse('2026-09-13T17:00:00+02:00')

    const segments = splitAtLocalMidnights({ startMs, endMs }, TZ)

    expect(segments).toHaveLength(4)
    expect(iso(segments[0].startMs)).toBe('2026-09-10T07:00:00.000Z')
    expect(iso(segments[3].endMs)).toBe('2026-09-13T15:00:00.000Z')
    // Contiguous: the union of the pieces is exactly the original interval.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startMs).toBe(segments[i - 1].endMs)
    }
  })

  it('splits on the local midnight of the profile timezone, not UTC', () => {
    // 20:00 -> 21:00 Tokyo on 10 Sept is 11:00 -> 12:00 UTC: same UTC day, and
    // also the same Tokyo day. One interval, no split.
    const startMs = Date.parse('2026-09-10T20:00:00+09:00')
    const endMs = Date.parse('2026-09-10T21:00:00+09:00')

    expect(splitAtLocalMidnights({ startMs, endMs }, 'Asia/Tokyo')).toHaveLength(1)
    // The same instants straddle midnight in Madrid (22:00 -> 23:00 on the
    // 10th is still one day there too) - use a Tokyo-morning event to prove the
    // frame matters: 08:00 Tokyo on the 11th is 23:00 UTC on the 10th.
    const morningStart = Date.parse('2026-09-11T08:00:00+09:00')
    const morningEnd = Date.parse('2026-09-11T09:00:00+09:00')
    expect(splitAtLocalMidnights({ startMs: morningStart, endMs: morningEnd }, 'Asia/Tokyo')).toEqual([
      { startMs: morningStart, endMs: morningEnd },
    ])
  })

  it('splits correctly across the Europe/Madrid spring-forward transition', () => {
    // 28 Mar 22:00 CET (UTC+1) -> 29 Mar 04:00 CEST (UTC+2). Clocks jump
    // forward at 02:00 local that morning, but local midnight (00:00, still
    // CET) is unaffected by that later jump.
    const startMs = Date.parse('2026-03-28T22:00:00+01:00')
    const endMs = Date.parse('2026-03-29T04:00:00+02:00')

    const segments = splitAtLocalMidnights({ startMs, endMs }, TZ)

    expect(segments.map((s) => [iso(s.startMs), iso(s.endMs)])).toEqual([
      ['2026-03-28T21:00:00.000Z', '2026-03-28T23:00:00.000Z'],
      ['2026-03-28T23:00:00.000Z', '2026-03-29T02:00:00.000Z'],
    ])
    expect(segments.map((s) => getLocalDateKey(new Date(s.startMs), TZ))).toEqual([
      '2026-03-28',
      '2026-03-29',
    ])
  })

  it('splits correctly across the Europe/Madrid fall-back transition', () => {
    // 24 Oct 22:00 CEST (UTC+2) -> 25 Oct 04:00 CET (UTC+1). Clocks fall back
    // at 03:00 local that morning.
    const startMs = Date.parse('2026-10-24T22:00:00+02:00')
    const endMs = Date.parse('2026-10-25T04:00:00+01:00')

    const segments = splitAtLocalMidnights({ startMs, endMs }, TZ)

    expect(segments.map((s) => [iso(s.startMs), iso(s.endMs)])).toEqual([
      ['2026-10-24T20:00:00.000Z', '2026-10-24T22:00:00.000Z'],
      ['2026-10-24T22:00:00.000Z', '2026-10-25T03:00:00.000Z'],
    ])
    expect(segments.map((s) => getLocalDateKey(new Date(s.startMs), TZ))).toEqual([
      '2026-10-24',
      '2026-10-25',
    ])
  })
})

describe('mergeIntervalsWithinLocalDays', () => {
  it('merges overlapping intervals on the same local day', () => {
    const a = { startMs: Date.parse('2026-09-10T09:00:00+02:00'), endMs: Date.parse('2026-09-10T10:00:00+02:00') }
    const b = { startMs: Date.parse('2026-09-10T09:30:00+02:00'), endMs: Date.parse('2026-09-10T11:00:00+02:00') }

    expect(mergeIntervalsWithinLocalDays([b, a], TZ)).toEqual([
      { startMs: a.startMs, endMs: b.endMs },
    ])
  })

  it('merges touching intervals on the same local day', () => {
    const a = { startMs: Date.parse('2026-09-10T09:00:00+02:00'), endMs: Date.parse('2026-09-10T10:00:00+02:00') }
    const b = { startMs: Date.parse('2026-09-10T10:00:00+02:00'), endMs: Date.parse('2026-09-10T11:00:00+02:00') }

    expect(mergeIntervalsWithinLocalDays([a, b], TZ)).toEqual([
      { startMs: a.startMs, endMs: b.endMs },
    ])
  })

  it('never merges across local midnight, even though the pieces touch', () => {
    // This is the guard that stops the merge undoing the split.
    const startMs = Date.parse('2026-09-10T22:00:00+02:00')
    const endMs = Date.parse('2026-09-11T02:00:00+02:00')
    const segments = splitAtLocalMidnights({ startMs, endMs }, TZ)

    expect(mergeIntervalsWithinLocalDays(segments, TZ)).toEqual(segments)
  })

  it('keeps non-overlapping intervals on the same day separate', () => {
    const a = { startMs: Date.parse('2026-09-10T09:00:00+02:00'), endMs: Date.parse('2026-09-10T10:00:00+02:00') }
    const b = { startMs: Date.parse('2026-09-10T14:00:00+02:00'), endMs: Date.parse('2026-09-10T15:00:00+02:00') }

    expect(mergeIntervalsWithinLocalDays([b, a], TZ)).toEqual([a, b])
  })
})

describe('buildBusyIntervals filters', () => {
  it('skips events that are not confirmed', () => {
    const result = build([
      event({ status: 'tentative' }),
      event({ status: 'cancelled' }),
    ])

    expect(result.intervals).toEqual([])
    expect(result.skipped.notConfirmed).toBe(2)
  })

  it('treats an absent status as confirmed', () => {
    const result = build([event({ status: null })])

    expect(result.intervals).toHaveLength(1)
    expect(result.skipped.notConfirmed).toBe(0)
  })

  it('skips all-day events entirely', () => {
    const result = build([
      event({ start: { date: '2026-09-10' }, end: { date: '2026-09-11' } }),
    ])

    expect(result.intervals).toEqual([])
    expect(result.skipped.allDay).toBe(1)
  })

  it('skips events marked free', () => {
    const result = build([event({ transparency: 'transparent' })])

    expect(result.intervals).toEqual([])
    expect(result.skipped.transparent).toBe(1)
  })

  it('skips our own Teams invites, case-insensitively', () => {
    const result = build([
      event({ organizer: { email: 'admin@lingualinkonline.onmicrosoft.com' } }),
      event({ organizer: { email: 'ADMIN@LINGUALINKONLINE.ONMICROSOFT.COM' } }),
    ])

    expect(result.intervals).toEqual([])
    expect(result.skipped.ownTeamsInvite).toBe(2)
  })

  it('keeps events organised by anyone else', () => {
    const result = build([event({ organizer: { email: 'client@example.com' } })])

    expect(result.intervals).toHaveLength(1)
    expect(result.skipped.ownTeamsInvite).toBe(0)
  })

  it('skips an event whose id is one of our own class blocks', () => {
    // The outbound sync wrote this event onto her calendar for a LinguaLink
    // class. Mirroring it back would block the slot the platform booked.
    const result = build([event({ id: 'evt-class-1' })], new Set(['evt-class-1']))

    expect(result.intervals).toEqual([])
    expect(result.skipped.ownClassEvent).toBe(1)
  })

  it('keeps an event whose id is not one of our class blocks', () => {
    const result = build([event({ id: 'evt-hers' })], new Set(['evt-class-1']))

    expect(result.intervals).toHaveLength(1)
    expect(result.skipped.ownClassEvent).toBe(0)
  })

  it('lets an event with no usable id through untouched, even with a populated set', () => {
    // An event we cannot identify is somebody else's commitment until proven
    // otherwise: over-blocking is this sync's safe direction.
    const result = build(
      [event({ id: undefined }), event({ id: null })],
      new Set(['evt-class-1'])
    )

    expect(result.intervals).toHaveLength(1) // the two overlap and merge into one row
    expect(result.skipped.ownClassEvent).toBe(0)
  })

  it('counts an event matching both echo filters exactly once, under the organiser check', () => {
    // Check 4 runs first and `continue`s, so check 5 never sees this event. The
    // point is that the two filters cannot double-count the same skip.
    const result = build(
      [event({ id: 'evt-class-1', organizer: { email: ORGANISER } })],
      new Set(['evt-class-1'])
    )

    expect(result.intervals).toEqual([])
    expect(result.skipped.ownTeamsInvite).toBe(1)
    expect(result.skipped.ownClassEvent).toBe(0)
  })

  it('skips only the class block in a mixed batch', () => {
    const result = build(
      [
        event({
          id: 'evt-class-1',
          start: { dateTime: '2026-09-10T09:00:00+02:00' },
          end: { dateTime: '2026-09-10T10:00:00+02:00' },
        }),
        event({
          id: 'evt-dentist',
          start: { dateTime: '2026-09-10T14:00:00+02:00' },
          end: { dateTime: '2026-09-10T15:00:00+02:00' },
        }),
      ],
      new Set(['evt-class-1'])
    )

    expect(result.intervals.map((i) => [iso(i.startMs), iso(i.endMs)])).toEqual([
      ['2026-09-10T12:00:00.000Z', '2026-09-10T13:00:00.000Z'],
    ])
    expect(result.skipped.ownClassEvent).toBe(1)
  })

  it('skips events with unusable or zero-width times', () => {
    const result = build([
      event({ start: { dateTime: 'not-a-date' } }),
      event({
        start: { dateTime: '2026-09-10T09:00:00+02:00' },
        end: { dateTime: '2026-09-10T09:00:00+02:00' },
      }),
    ])

    expect(result.intervals).toEqual([])
    expect(result.skipped.unusableTimes).toBe(2)
  })

  it('clamps an in-progress event to the start of the window', () => {
    const windowStartMs = Date.parse('2026-09-10T09:30:00+02:00')
    const result = buildBusyIntervals(
      [
        event({
          start: { dateTime: '2026-09-10T09:00:00+02:00' },
          end: { dateTime: '2026-09-10T10:00:00+02:00' },
        }),
      ],
      {
        timezone: TZ,
        organiserEmail: ORGANISER,
        classEventIds: new Set(NO_CLASS_EVENTS),
        windowStartMs,
        windowEndMs: WINDOW_END,
      }
    )

    expect(result.intervals).toEqual([
      { startMs: windowStartMs, endMs: Date.parse('2026-09-10T10:00:00+02:00') },
    ])
  })
})

describe('buildBusyIntervals end to end', () => {
  it('splits a cross-midnight event into two rows without merging them back', () => {
    const result = build([
      event({
        start: { dateTime: '2026-09-10T22:00:00+02:00' },
        end: { dateTime: '2026-09-11T02:00:00+02:00' },
      }),
    ])

    expect(result.intervals.map((i) => [iso(i.startMs), iso(i.endMs)])).toEqual([
      ['2026-09-10T20:00:00.000Z', '2026-09-10T22:00:00.000Z'],
      ['2026-09-10T22:00:00.000Z', '2026-09-11T00:00:00.000Z'],
    ])
  })

  it('merges two overlapping meetings into one row', () => {
    const result = build([
      event({
        start: { dateTime: '2026-09-10T09:00:00+02:00' },
        end: { dateTime: '2026-09-10T10:00:00+02:00' },
      }),
      event({
        id: 'evt-2',
        start: { dateTime: '2026-09-10T09:45:00+02:00' },
        end: { dateTime: '2026-09-10T11:00:00+02:00' },
      }),
    ])

    expect(result.intervals.map((i) => [iso(i.startMs), iso(i.endMs)])).toEqual([
      ['2026-09-10T07:00:00.000Z', '2026-09-10T09:00:00.000Z'],
    ])
  })

  it('returns rows in chronological order across days', () => {
    const result = build([
      event({
        id: 'later',
        start: { dateTime: '2026-09-12T09:00:00+02:00' },
        end: { dateTime: '2026-09-12T10:00:00+02:00' },
      }),
      event({
        id: 'earlier',
        start: { dateTime: '2026-09-10T09:00:00+02:00' },
        end: { dateTime: '2026-09-10T10:00:00+02:00' },
      }),
    ])

    expect(result.intervals.map((i) => iso(i.startMs))).toEqual([
      '2026-09-10T07:00:00.000Z',
      '2026-09-12T07:00:00.000Z',
    ])
  })

  it('keeps two independent events touching exactly at local midnight as two rows', () => {
    const result = build([
      event({
        id: 'ends-at-midnight',
        start: { dateTime: '2026-09-10T20:00:00+02:00' },
        end: { dateTime: '2026-09-11T00:00:00+02:00' },
      }),
      event({
        id: 'starts-at-midnight',
        start: { dateTime: '2026-09-11T00:00:00+02:00' },
        end: { dateTime: '2026-09-11T01:00:00+02:00' },
      }),
    ])

    expect(result.intervals).toHaveLength(2)
    expect(result.intervals.map((i) => [iso(i.startMs), iso(i.endMs)])).toEqual([
      ['2026-09-10T18:00:00.000Z', '2026-09-10T22:00:00.000Z'],
      ['2026-09-10T22:00:00.000Z', '2026-09-10T23:00:00.000Z'],
    ])
  })
})

describe('fetchGoogleCalendarEvents', () => {
  it('bails after MAX_EVENT_PAGES rather than returning a partial event list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [], nextPageToken: 'more' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )

    try {
      const result = await fetchGoogleCalendarEvents({
        accessToken: 'token',
        timeMinIso: '2026-09-01T00:00:00.000Z',
        timeMaxIso: '2026-10-31T00:00:00.000Z',
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected fetchGoogleCalendarEvents to fail')
      expect(result.error).toContain('refusing to write a partial calendar')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---- Outbound writes --------------------------------------------------------

const TOKEN = 'ya29.test-access-token'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Stubs fetch and hands the mock back, because for these helpers the REQUEST is
 * the thing under test: the no-attendees rule and the header-only token live in
 * what we send, not in what comes back.
 */
function stubFetch(respond: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => respond(url, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The one request the helper made - the call count is also the no-retry check. */
function requestOf(fetchMock: ReturnType<typeof stubFetch>) {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]
  return { url, init }
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function authOf(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.Authorization
}

describe('Google Calendar outbound writes', () => {
  // console.error is this module's failure channel and the rejection cases below
  // drive it on purpose; silencing keeps the run readable. unstubAllGlobals puts
  // the real fetch back after every case.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('createGoogleEvent', () => {
    const create = () =>
      createGoogleEvent({
        accessToken: TOKEN,
        summary: 'LinguaLink class - Maria',
        startIso: '2026-09-10T09:00:00+02:00',
        endIso: '2026-09-10T10:00:00+02:00',
        timezone: TZ,
      })

    it('returns the created event id', async () => {
      const fetchMock = stubFetch(() => jsonResponse({ id: 'evt-created-123' }, 200))

      expect(await create()).toEqual({ ok: true, eventId: 'evt-created-123' })

      const { url, init } = requestOf(fetchMock)
      expect(url).toBe(GOOGLE_CALENDAR_EVENTS_ENDPOINT)
      expect(init.method).toBe('POST')
      expect(bodyOf(init)).toEqual({
        summary: 'LinguaLink class - Maria',
        start: { dateTime: '2026-09-10T09:00:00+02:00', timeZone: TZ },
        end: { dateTime: '2026-09-10T10:00:00+02:00', timeZone: TZ },
      })
      // The 10s abort signal is attached to every request, not just the reads.
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('sends NO attendees and nothing else that could notify anybody', async () => {
      const fetchMock = stubFetch(() => jsonResponse({ id: 'evt-created-123' }, 200))

      await create()

      const { url, init } = requestOf(fetchMock)
      const body = bodyOf(init)

      // THE rule: this event is a private block on one person's own calendar.
      // Any of these fields turns it into an invitation and mails a student or
      // a teacher from her personal Google account.
      expect(body).not.toHaveProperty('attendees')
      for (const field of [
        'sendUpdates',
        'sendNotifications',
        'guestsCanModify',
        'guestsCanInviteOthers',
        'guestsCanSeeOtherGuests',
      ]) {
        expect(body).not.toHaveProperty(field)
      }
      // sendUpdates is a QUERY parameter on this endpoint rather than a body
      // field, so a bare URL is what proves it is not being set.
      expect(url).toBe(GOOGLE_CALENDAR_EVENTS_ENDPOINT)
      expect(url).not.toContain('?')

      // Omitted reminders means the calendar's own defaults apply.
      expect(body).not.toHaveProperty('reminders')

      // Token in the Authorization header, never in the URL.
      expect(authOf(init)).toBe(`Bearer ${TOKEN}`)
      expect(url).not.toContain(TOKEN)
    })

    it('returns the error shape when Google rejects the insert', async () => {
      const fetchMock = stubFetch(() =>
        jsonResponse({ error: { message: 'Insufficient Permission' } }, 403)
      )

      const result = await create()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected createGoogleEvent to fail')
      expect(result.error).toBe('Google Calendar returned HTTP 403: Insufficient Permission')
      // One request, then report - no retry inside a user-facing path.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reports a failure when the insert answers without an id', async () => {
      stubFetch(() => jsonResponse({ summary: 'created but unidentifiable' }, 200))

      const result = await create()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected createGoogleEvent to fail')
      expect(result.error).toContain('no id')
    })

    it('reports a network failure instead of throwing', async () => {
      stubFetch(() => {
        throw new Error('socket hang up')
      })

      const result = await create()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected createGoogleEvent to fail')
      expect(result.error).toContain('network or timeout')
    })
  })

  describe('updateGoogleEvent', () => {
    const update = (eventId = 'evt-123') =>
      updateGoogleEvent({
        accessToken: TOKEN,
        eventId,
        startIso: '2026-09-11T15:00:00+02:00',
        endIso: '2026-09-11T16:00:00+02:00',
        timezone: TZ,
      })

    it('patches start and end, and nothing else', async () => {
      const fetchMock = stubFetch(() => jsonResponse({ id: 'evt-123' }, 200))

      expect(await update()).toEqual({ ok: true })

      const { url, init } = requestOf(fetchMock)
      expect(init.method).toBe('PATCH')
      expect(url).toBe(`${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/evt-123`)

      const body = bodyOf(init)
      // Exactly two keys. A summary here would overwrite a rename she made on
      // her own calendar; attendees would mail somebody.
      expect(Object.keys(body).sort()).toEqual(['end', 'start'])
      expect(body).toEqual({
        start: { dateTime: '2026-09-11T15:00:00+02:00', timeZone: TZ },
        end: { dateTime: '2026-09-11T16:00:00+02:00', timeZone: TZ },
      })
      expect(authOf(init)).toBe(`Bearer ${TOKEN}`)
    })

    it('percent-encodes the event id into the path', async () => {
      const fetchMock = stubFetch(() => jsonResponse({ id: 'x' }, 200))

      await update('evt 123/456')

      const { url } = requestOf(fetchMock)
      expect(url).toBe(`${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/evt%20123%2F456`)
    })

    it('treats a missing event as a real failure, unlike delete', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Not Found' } }, 404))

      const result = await update()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected updateGoogleEvent to fail')
      expect(result.error).toBe('Google Calendar returned HTTP 404: Not Found')
    })

    it('reports a network failure instead of throwing', async () => {
      stubFetch(() => {
        throw new Error('socket hang up')
      })

      const result = await update()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected updateGoogleEvent to fail')
      expect(result.error).toContain('network or timeout')
    })
  })

  describe('deleteGoogleEvent', () => {
    const remove = () => deleteGoogleEvent({ accessToken: TOKEN, eventId: 'evt-123' })

    it('deletes the event', async () => {
      // Google answers 204 No Content: nothing may be parsed on this path.
      const fetchMock = stubFetch(() => new Response(null, { status: 204 }))

      expect(await remove()).toEqual({ ok: true })

      const { url, init } = requestOf(fetchMock)
      expect(init.method).toBe('DELETE')
      expect(url).toBe(`${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/evt-123`)
      expect(init.body).toBeUndefined()
      expect(authOf(init)).toBe(`Bearer ${TOKEN}`)
      expect(url).not.toContain(TOKEN)
    })

    it('treats 404 as success - the event is already gone', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Not Found' } }, 404))

      expect(await remove()).toEqual({ ok: true })
    })

    it('treats 410 as success - the event was already deleted', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Resource has been deleted' } }, 410))

      expect(await remove()).toEqual({ ok: true })
    })

    it('surfaces a real error rather than pretending the event is gone', async () => {
      const fetchMock = stubFetch(() => jsonResponse({ error: { message: 'Backend Error' } }, 500))

      const result = await remove()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected deleteGoogleEvent to fail')
      expect(result.error).toBe('Google Calendar returned HTTP 500: Backend Error')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('surfaces a permission failure, which says nothing about the event', async () => {
      stubFetch(() => jsonResponse({ error: { message: 'Insufficient Permission' } }, 403))

      const result = await remove()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected deleteGoogleEvent to fail')
      expect(result.error).toBe('Google Calendar returned HTTP 403: Insufficient Permission')
    })

    it('reports a network failure instead of throwing', async () => {
      stubFetch(() => {
        throw new Error('socket hang up')
      })

      const result = await remove()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected deleteGoogleEvent to fail')
      expect(result.error).toContain('network or timeout')
    })
  })
})
