import { describe, expect, it, vi } from 'vitest'
import {
  buildBusyIntervals,
  fetchGoogleCalendarEvents,
  mergeIntervalsWithinLocalDays,
  splitAtLocalMidnights,
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

function build(events: GoogleCalendarEvent[]) {
  return buildBusyIntervals(events, {
    timezone: TZ,
    organiserEmail: ORGANISER,
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
