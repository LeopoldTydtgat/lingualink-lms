import { describe, it, expect } from 'vitest'
import {
  buildWeekSlots,
  getWeekWindow,
  type AvailabilityRecord,
  type BuildWeekSlotsInput,
} from './slotEngine'
import { addDaysToDateKey } from '@/lib/utils/timezone'

/**
 * NEW317 regression net for the availability slot engine.
 *
 * The bug class: the old route keyed each day's slots by formatting UTC
 * midnight of the teacher-week date in the requested timezone — every
 * UTC-negative display timezone shifted ALL keys one day back (slots rendered
 * on the wrong columns, last column empty). And whole-day bucketing was wrong
 * regardless: a single slot can fall on a different display-local day than
 * the teacher-calendar date that generated it (Tokyo Mon 08:00 = NY Sun
 * 19:00). These tests pin the per-slot semantics so neither can ship again.
 */

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function plus30(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const total = h * 60 + m + 30
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

// One general weekly 30-min slot (matches the availability table's shape).
function general(dayOfWeek: number, startTime: string): AvailabilityRecord {
  return {
    type: 'general',
    day_of_week: dayOfWeek,
    start_time: startTime,
    end_time: plus30(startTime),
    start_at: null,
    end_at: null,
    is_available: true,
  }
}

function override(
  startAt: string,
  endAt: string,
  opts: { type?: string; available?: boolean } = {}
): AvailabilityRecord {
  return {
    type: opts.type ?? 'specific',
    day_of_week: null,
    start_time: null,
    end_time: null,
    start_at: startAt,
    end_at: endAt,
    is_available: opts.available ?? false,
  }
}

function makeInput(over: Partial<BuildWeekSlotsInput> = {}): BuildWeekSlotsInput {
  return {
    weekStart: '2026-06-08', // a Monday
    displayTimezone: 'UTC',
    teacherTimezone: 'UTC',
    records: [],
    booked: [],
    // Far enough before the test week that the 24h cutoff never interferes
    // unless a test sets nowMs itself.
    nowMs: Date.parse('2026-06-01T00:00:00Z'),
    isAdmin: false,
    ...over,
  }
}

function availableIsos(slots: { startIso: string; available: boolean }[] | undefined): string[] {
  return (slots ?? []).filter((s) => s.available).map((s) => s.startIso)
}

// ─── addDaysToDateKey ─────────────────────────────────────────────────────────

describe('addDaysToDateKey', () => {
  it('steps within a month', () => {
    expect(addDaysToDateKey('2026-06-08', 3)).toBe('2026-06-11')
  })
  it('crosses month and year boundaries', () => {
    expect(addDaysToDateKey('2026-06-30', 1)).toBe('2026-07-01')
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('negative days step backwards across boundaries', () => {
    expect(addDaysToDateKey('2026-06-01', -1)).toBe('2026-05-31')
    expect(addDaysToDateKey('2026-01-01', -1)).toBe('2025-12-31')
  })
  it('handles leap day', () => {
    expect(addDaysToDateKey('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysToDateKey('2028-02-29', 1)).toBe('2028-03-01')
  })
})

// ─── getWeekWindow ────────────────────────────────────────────────────────────

describe('getWeekWindow', () => {
  it('emits the 7 calendar keys of the requested week', () => {
    const { displayDateKeys } = getWeekWindow('2026-06-08', 'America/New_York')
    expect(displayDateKeys).toEqual([
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11',
      '2026-06-12', '2026-06-13', '2026-06-14',
    ])
  })

  it('window bounds are the display-tz midnights as true UTC instants', () => {
    // EDT is UTC-4 in June: Mon 00:00 local = 04:00Z.
    const w = getWeekWindow('2026-06-08', 'America/New_York')
    expect(new Date(w.windowStartMs).toISOString()).toBe('2026-06-08T04:00:00.000Z')
    expect(new Date(w.windowEndMs).toISOString()).toBe('2026-06-15T04:00:00.000Z')
  })

  it('US spring-forward week is 167 hours long', () => {
    // America/New_York DST starts Sun 2026-03-08 02:00 → the Mar 2–8 week
    // loses an hour. Window: Mar 2 00:00 EST (05:00Z) → Mar 9 00:00 EDT (04:00Z).
    const w = getWeekWindow('2026-03-02', 'America/New_York')
    expect(w.windowEndMs - w.windowStartMs).toBe(167 * 3600_000)
  })

  it('EU fall-back week is 169 hours long', () => {
    // Europe/Madrid DST ends Sun 2026-10-25 03:00 → the Oct 19–25 week gains
    // an hour. Window: Oct 19 00:00 CEST (Oct 18 22:00Z) → Oct 26 00:00 CET (Oct 25 23:00Z).
    const w = getWeekWindow('2026-10-19', 'Europe/Madrid')
    expect(w.windowEndMs - w.windowStartMs).toBe(169 * 3600_000)
  })
})

// ─── buildWeekSlots — per-slot bucketing across timezones ────────────────────

describe('buildWeekSlots — per-slot display-tz bucketing', () => {
  it('always returns exactly the 7 display date keys (empty arrays included)', () => {
    const result = buildWeekSlots(makeInput({ displayTimezone: 'America/New_York' }))
    expect(Object.keys(result).sort()).toEqual([
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11',
      '2026-06-12', '2026-06-13', '2026-06-14',
    ])
    for (const key of Object.keys(result)) expect(result[key]).toEqual([])
  })

  it('UTC-negative display tz (America/New_York): slot lands on its own NY date, not one day back', () => {
    // Teacher UTC, Wed 12:00Z = NY Wed 08:00 → must key '2026-06-10'. The old
    // per-day keying formatted UTC midnight of Jun 10 in NY = '2026-06-09'.
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'America/New_York',
      records: [general(3, '12:00:00')],
    }))
    expect(availableIsos(result['2026-06-10'])).toEqual(['2026-06-10T12:00:00.000Z'])
    expect(result['2026-06-09']).toEqual([])
  })

  it('teacher and display on opposite sides of UTC: Tokyo Mon 08:00 buckets as NY Sun 19:00', () => {
    // NY week Mon Jun 8 – Sun Jun 14. Tokyo Mon Jun 8 08:00 = Jun 7 23:00Z =
    // NY Sun Jun 7 19:00 — BEFORE the window → excluded. Tokyo Mon Jun 15
    // 08:00 = Jun 14 23:00Z = NY Sun Jun 14 19:00 — inside the window → the
    // week's LAST column (Sunday), generated from a teacher date outside the
    // naive 7-day span. Per-day bucketing can never produce this.
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'America/New_York',
      teacherTimezone: 'Asia/Tokyo',
      records: [general(1, '08:00:00')],
    }))
    expect(availableIsos(result['2026-06-14'])).toEqual(['2026-06-14T23:00:00.000Z'])
    expect(result['2026-06-08']).toEqual([])
  })

  it('UTC-positive display tz (Asia/Tokyo): Madrid Fri 18:00 buckets as Tokyo Sat 01:00', () => {
    // Madrid Fri Jun 12 18:00 CEST = 16:00Z = Tokyo Sat Jun 13 01:00.
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'Asia/Tokyo',
      teacherTimezone: 'Europe/Madrid',
      records: [general(5, '18:00:00')],
    }))
    expect(availableIsos(result['2026-06-13'])).toEqual(['2026-06-12T16:00:00.000Z'])
    expect(result['2026-06-12']).toEqual([])
  })

  it('slot at teacher midnight lands on the adjacent display-tz day', () => {
    // Madrid Mon 00:00 CEST = Sun 22:00Z = London Sun 23:00. London week Mon
    // Jun 8 – Sun Jun 14: Madrid Mon Jun 8 00:00 (Jun 7 22:00Z) is before the
    // window start (Jun 7 23:00Z) → excluded; Madrid Mon Jun 15 00:00
    // (Jun 14 22:00Z) is inside → keyed under London Sunday Jun 14.
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'Europe/London',
      teacherTimezone: 'Europe/Madrid',
      records: [general(1, '00:00:00')],
    }))
    expect(availableIsos(result['2026-06-14'])).toEqual(['2026-06-14T22:00:00.000Z'])
    expect(result['2026-06-08']).toEqual([])
  })

  it('DST transition week: slot after the spring-forward jump keys correctly', () => {
    // NY teacher + NY display, week Mar 2–8 2026 (DST starts Sun Mar 8 02:00).
    // Sun 10:00 EDT = 14:00Z → key '2026-03-08'.
    const result = buildWeekSlots(makeInput({
      weekStart: '2026-03-02',
      displayTimezone: 'America/New_York',
      teacherTimezone: 'America/New_York',
      records: [general(0, '10:00:00')],
      nowMs: Date.parse('2026-02-01T00:00:00Z'),
    }))
    expect(availableIsos(result['2026-03-08'])).toEqual(['2026-03-08T14:00:00.000Z'])
  })

  it('sorts multiple slots within a day by start instant', () => {
    const result = buildWeekSlots(makeInput({
      records: [general(1, '14:00:00'), general(1, '09:00:00'), general(1, '09:30:00')],
    }))
    expect(availableIsos(result['2026-06-08'])).toEqual([
      '2026-06-08T09:00:00.000Z',
      '2026-06-08T09:30:00.000Z',
      '2026-06-08T14:00:00.000Z',
    ])
  })
})

// ─── buildWeekSlots — add-overrides ──────────────────────────────────────────

describe('buildWeekSlots — is_available=true overrides', () => {
  it('selects overrides by instant overlap and window-filters the generated slots', () => {
    // Override starts on the PREVIOUS UTC date (23:00 Jun 7) — the old
    // startsWith(dateStr) selection missed it entirely. Candidates 23:00,
    // 23:30 fall before the window; 00:00, 00:30 survive.
    const result = buildWeekSlots(makeInput({
      records: [override('2026-06-07T23:00:00.000Z', '2026-06-08T01:00:00.000Z', { available: true })],
    }))
    expect(availableIsos(result['2026-06-08'])).toEqual([
      '2026-06-08T00:00:00.000Z',
      '2026-06-08T00:30:00.000Z',
    ])
  })

  it('dedupes an override slot that coincides with a general slot', () => {
    const result = buildWeekSlots(makeInput({
      records: [
        general(1, '10:00:00'),
        override('2026-06-08T10:00:00.000Z', '2026-06-08T10:30:00.000Z', { available: true }),
      ],
    }))
    expect(result['2026-06-08']).toHaveLength(1)
    expect(result['2026-06-08'][0].startIso).toBe('2026-06-08T10:00:00.000Z')
  })
})

// ─── buildWeekSlots — NEW324 extended candidates past the week window ────────

describe('buildWeekSlots — NEW324 extended slots past windowEndMs', () => {
  // UTC/UTC week Jun 8–14: windowEnd = Jun 15 00:00Z, candidateEnd = 01:00Z.
  // Day 7 is Sunday Jun 14 (dow 0); day 8 is Monday Jun 15 (dow 1).

  it('general availability crossing week-end midnight emits the day-8 continuation slots', () => {
    // A 90-min run starting Sun 23:00 needs 23:00, 23:30, 00:00; starting
    // 23:30 needs up to 00:30. All four instants must be present, the day-8
    // ones keyed under the day-8 display date.
    const result = buildWeekSlots(makeInput({
      records: [
        general(0, '23:00:00'), general(0, '23:30:00'),
        general(1, '00:00:00'), general(1, '00:30:00'),
      ],
    }))
    expect(availableIsos(result['2026-06-14'])).toEqual([
      '2026-06-14T23:00:00.000Z',
      '2026-06-14T23:30:00.000Z',
    ])
    expect(availableIsos(result['2026-06-15'])).toEqual([
      '2026-06-15T00:00:00.000Z',
      '2026-06-15T00:30:00.000Z',
    ])
  })

  it('is_available=true override spanning week-end midnight emits the day-8 continuation slots', () => {
    const result = buildWeekSlots(makeInput({
      records: [override('2026-06-14T23:00:00.000Z', '2026-06-15T01:00:00.000Z', { available: true })],
    }))
    expect(availableIsos(result['2026-06-14'])).toEqual([
      '2026-06-14T23:00:00.000Z',
      '2026-06-14T23:30:00.000Z',
    ])
    expect(availableIsos(result['2026-06-15'])).toEqual([
      '2026-06-15T00:00:00.000Z',
      '2026-06-15T00:30:00.000Z',
    ])
  })

  it('is_available=true override lying WHOLLY past windowEndMs still emits extended slots', () => {
    // The override-selection prefilter must widen with the cursor bound: a
    // day-8 00:00–01:00 override supplies the continuation instants for a run
    // whose in-window start comes from a DIFFERENT record.
    const result = buildWeekSlots(makeInput({
      records: [override('2026-06-15T00:00:00.000Z', '2026-06-15T01:00:00.000Z', { available: true })],
    }))
    expect(availableIsos(result['2026-06-15'])).toEqual([
      '2026-06-15T00:00:00.000Z',
      '2026-06-15T00:30:00.000Z',
    ])
  })

  it('a booked lesson starting exactly at windowEndMs blocks the extended slots it covers', () => {
    // Engine-level proof that the route's widened UPPER fetch bound matters:
    // a lesson at Jun 15 00:00Z (= windowEndMs) + 60min must mark 00:00 and
    // 00:30 unavailable, leaving the in-window Sun 23:30 slot untouched.
    const result = buildWeekSlots(makeInput({
      records: [general(0, '23:30:00'), general(1, '00:00:00'), general(1, '00:30:00')],
      booked: [{ scheduled_at: '2026-06-15T00:00:00.000Z', duration_minutes: 60 }],
    }))
    expect(availableIsos(result['2026-06-14'])).toEqual(['2026-06-14T23:30:00.000Z'])
    expect(result['2026-06-15']).toEqual([
      { startIso: '2026-06-15T00:00:00.000Z', available: false },
      { startIso: '2026-06-15T00:30:00.000Z', available: false },
    ])
  })

  it('a holiday on the extended slot\'s teacher-local date blocks it', () => {
    // Holiday stored with date portion 2026-06-15 blocks the day-8 slot but
    // not the same weekly record's in-window Mon Jun 8 slot.
    const result = buildWeekSlots(makeInput({
      records: [
        general(1, '00:00:00'),
        override('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z', { type: 'holiday' }),
      ],
    }))
    expect(availableIsos(result['2026-06-08'])).toEqual(['2026-06-08T00:00:00.000Z'])
    expect(result['2026-06-15']).toEqual([
      { startIso: '2026-06-15T00:00:00.000Z', available: false },
    ])
  })

  it('lower bound unchanged: no slots before windowStartMs appear', () => {
    // Sunday 23:00 also matches Sun Jun 7, the day BEFORE the window — that
    // instant must stay excluded; only the in-window Jun 14 one survives.
    const result = buildWeekSlots(makeInput({
      records: [general(0, '23:00:00')],
    }))
    expect(result['2026-06-07']).toBeUndefined()
    expect(availableIsos(result['2026-06-14'])).toEqual(['2026-06-14T23:00:00.000Z'])
  })
})

// ─── buildWeekSlots — blocking semantics (unchanged from the old route) ──────

describe('buildWeekSlots — blocking', () => {
  it('a booked lesson starting before the window still blocks the slot it overlaps', () => {
    // Lesson Jun 7 23:30Z + 60min covers 23:30–00:30 → blocks the Mon 00:00 slot.
    const result = buildWeekSlots(makeInput({
      records: [general(1, '00:00:00')],
      booked: [{ scheduled_at: '2026-06-07T23:30:00.000Z', duration_minutes: 60 }],
    }))
    expect(result['2026-06-08']).toEqual([
      { startIso: '2026-06-08T00:00:00.000Z', available: false },
    ])
  })

  it('timed is_available=false override blocks by instant overlap', () => {
    const result = buildWeekSlots(makeInput({
      records: [
        general(3, '12:00:00'),
        override('2026-06-10T12:00:00.000Z', '2026-06-10T13:00:00.000Z'),
      ],
    }))
    expect(result['2026-06-10']).toEqual([
      { startIso: '2026-06-10T12:00:00.000Z', available: false },
    ])
  })

  it('holiday blocks the whole TEACHER-local calendar date (NEW174 stored date portion)', () => {
    // Tokyo Tue Jun 9 08:00 = Jun 8 23:00Z. Holiday stored with date portion
    // 2026-06-09 blocks the teacher-local date the slot falls on.
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'Asia/Tokyo',
      teacherTimezone: 'Asia/Tokyo',
      records: [
        general(2, '08:00:00'),
        override('2026-06-09T00:00:00.000Z', '2026-06-09T23:59:59.999Z', { type: 'holiday' }),
      ],
    }))
    expect(result['2026-06-09']).toEqual([
      { startIso: '2026-06-08T23:00:00.000Z', available: false },
    ])
  })

  it('holiday does NOT bleed onto adjacent teacher dates', () => {
    const result = buildWeekSlots(makeInput({
      displayTimezone: 'Asia/Tokyo',
      teacherTimezone: 'Asia/Tokyo',
      records: [
        general(2, '08:00:00'), // Tue Jun 9 — holiday
        general(3, '08:00:00'), // Wed Jun 10 — not a holiday
        override('2026-06-09T00:00:00.000Z', '2026-06-09T23:59:59.999Z', { type: 'holiday' }),
      ],
    }))
    expect(availableIsos(result['2026-06-10'])).toEqual(['2026-06-09T23:00:00.000Z'])
  })
})

// ─── buildWeekSlots — 24h cutoff and admin bypass ────────────────────────────

describe('buildWeekSlots — 24h cutoff', () => {
  const records = [general(1, '12:00:00'), general(2, '12:00:00')] // Mon + Tue 12:00Z

  it('blocks slots within 24h for students, keeps later ones', () => {
    const result = buildWeekSlots(makeInput({
      records,
      nowMs: Date.parse('2026-06-08T00:00:00Z'), // Mon 12:00 is within 24h; Tue 12:00 is not
    }))
    expect(result['2026-06-08']).toEqual([{ startIso: '2026-06-08T12:00:00.000Z', available: false }])
    expect(result['2026-06-09']).toEqual([{ startIso: '2026-06-09T12:00:00.000Z', available: true }])
  })

  it('admin bypasses the 24h rule but not the past', () => {
    const within24h = buildWeekSlots(makeInput({
      records,
      nowMs: Date.parse('2026-06-08T00:00:00Z'),
      isAdmin: true,
    }))
    expect(within24h['2026-06-08']).toEqual([{ startIso: '2026-06-08T12:00:00.000Z', available: true }])

    const past = buildWeekSlots(makeInput({
      records,
      nowMs: Date.parse('2026-06-08T13:00:00Z'), // Mon 12:00 already started
      isAdmin: true,
    }))
    expect(past['2026-06-08']).toEqual([{ startIso: '2026-06-08T12:00:00.000Z', available: false }])
  })
})

// ─── buildWeekSlots — admin single-date flow shape ───────────────────────────

describe('buildWeekSlots — admin flows (display tz = teacher tz, arbitrary weekStart)', () => {
  it('a mid-week weekStart keys the requested date itself (BookingFlow/EditClass read slots[selectedDate])', () => {
    // NY teacher, display = teacher tz, weekStart Wed Jun 10. Wed 09:00 EDT =
    // 13:00Z must appear under '2026-06-10' — the exact key the admin clients
    // read. The old code keyed it '2026-06-09' for UTC-negative teacher tzs.
    const result = buildWeekSlots(makeInput({
      weekStart: '2026-06-10',
      displayTimezone: 'America/New_York',
      teacherTimezone: 'America/New_York',
      records: [general(3, '09:00:00')],
    }))
    expect(availableIsos(result['2026-06-10'])).toEqual(['2026-06-10T13:00:00.000Z'])
  })
})
