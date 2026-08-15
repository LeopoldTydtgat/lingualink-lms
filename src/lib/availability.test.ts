import { describe, it, expect } from 'vitest'
import { isSlotAvailable, localTimeToUtcMs } from './availability'
import { buildWeekSlots } from '@/app/api/student/availability/slotEngine'
import { isBookableStart } from '@/lib/bookingGrid'

/**
 * NEW322 regression net for the booking write gate.
 *
 * The bug class: isSlotAvailable selected is_available=true 'specific'
 * add-overrides by a startsWith match on the requested instant's UTC date, so
 * a teacher-local override straddling UTC midnight attached to the
 * neighbouring UTC day and was missed. Since NEW317 the display route
 * (slotEngine) selects add-overrides by instant overlap, so the grid could
 * offer a slot from a midnight-straddling override that this gate then
 * rejected at confirm. These tests pin the overlap semantics on the gate side.
 */

// ─── Fixture helpers ──────────────────────────────────────────────────────────

interface AvailabilityRecord {
  type: string
  day_of_week: number | null
  start_time: string | null
  end_time: string | null
  start_at: string | null
  end_at: string | null
  is_available: boolean
}

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

type AdminClient = Parameters<typeof isSlotAvailable>[3]

// Mocks exactly the two queries isSlotAvailable issues: the profiles timezone
// lookup (maybeSingle) and the availability select (awaited thenable).
function mockAdminClient(timezone: string, records: AvailabilityRecord[]): AdminClient {
  return {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { timezone }, error: null }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: records }),
        }),
      }
    },
  } as unknown as AdminClient
}

const TEACHER = 'teacher-1'

function check(
  timezone: string,
  records: AvailabilityRecord[],
  scheduledAtUtc: string,
  durationMinutes: number
): Promise<boolean> {
  return isSlotAvailable(TEACHER, scheduledAtUtc, durationMinutes, mockAdminClient(timezone, records))
}

// ─── NEW322: add-overrides selected by instant overlap, not UTC-date prefix ──

describe('isSlotAvailable — add-overrides straddling UTC midnight (NEW322)', () => {
  it('UTC-negative teacher tz: booking after UTC midnight inside an override that started the previous UTC day passes', async () => {
    // NY Mon Jun 8 19:00–21:00 EDT = Jun 8 23:00Z – Jun 9 01:00Z. Booking
    // Jun 9 00:00Z (NY Mon 20:00) is inside it, but the old startsWith match
    // scoped overrides to the request's UTC date (Jun 9) and missed this one.
    const records = [override('2026-06-08T23:00:00.000Z', '2026-06-09T01:00:00.000Z', { available: true })]
    await expect(check('America/New_York', records, '2026-06-09T00:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('UTC-positive teacher tz: booking the final pre-cutoff slot of an override that started the previous UTC day passes', async () => {
    // Tokyo Tue Jun 9 07:00–09:30 JST = Jun 8 22:00Z – Jun 9 00:30Z. Booking
    // Jun 9 00:00Z (Tokyo 09:00) sits on the next UTC day relative to start_at.
    const records = [override('2026-06-08T22:00:00.000Z', '2026-06-09T00:30:00.000Z', { available: true })]
    await expect(check('Asia/Tokyo', records, '2026-06-09T00:00:00.000Z', 30)).resolves.toBe(true)
  })

  it('an override fully on the neighbouring UTC day that does NOT overlap the request stays excluded', async () => {
    // Broadened selection must not create availability out of a non-overlapping
    // override on the adjacent UTC date.
    const records = [override('2026-06-08T18:00:00.000Z', '2026-06-08T20:00:00.000Z', { available: true })]
    await expect(check('America/New_York', records, '2026-06-09T18:00:00.000Z', 30)).resolves.toBe(false)
  })

  it('a booking whose duration extends past the override end is rejected', async () => {
    // Override Jun 8 23:00Z – Jun 9 00:30Z overlaps the requested [00:00, 01:00)
    // window, but only the 00:00 segment fits — the 00:30 segment does not.
    const records = [override('2026-06-08T23:00:00.000Z', '2026-06-09T00:30:00.000Z', { available: true })]
    await expect(check('America/New_York', records, '2026-06-09T00:00:00.000Z', 60)).resolves.toBe(false)
  })
})

// ─── NEW326: localTimeToUtcMs is date-aware at exactly-±12h offsets ───────────

describe('localTimeToUtcMs — date-aware offset derivation (NEW326)', () => {
  // The old probe diffed local HOUR:MINUTE only; ±720 min is ambiguous (+12h and
  // -12h share a wall clock) and the wrap clamp tie-broke it toward "no
  // adjustment", landing UTC+12 afternoons (and all +13 NZDT times) a day off.
  const at = (dateStr: string, timeStr: string, tz: string) =>
    new Date(localTimeToUtcMs(dateStr, timeStr, tz)).toISOString()

  it('Pacific/Auckland (NZST, UTC+12): afternoon and evening resolve on the requested date', () => {
    expect(at('2026-06-09', '23:30:00', 'Pacific/Auckland')).toBe('2026-06-09T11:30:00.000Z')
    expect(at('2026-06-09', '13:00:00', 'Pacific/Auckland')).toBe('2026-06-09T01:00:00.000Z')
  })

  it('Pacific/Auckland morning (already correct before the fix) is unchanged', () => {
    expect(at('2026-06-09', '08:00:00', 'Pacific/Auckland')).toBe('2026-06-08T20:00:00.000Z')
  })

  it('UTC-negative zone is unchanged (America/New_York, EDT)', () => {
    expect(at('2026-06-09', '23:30:00', 'America/New_York')).toBe('2026-06-10T03:30:00.000Z')
  })

  it('offsets beyond +12 resolve correctly (Pacific/Auckland NZDT, UTC+13, January)', () => {
    expect(at('2026-01-15', '13:00:00', 'Pacific/Auckland')).toBe('2026-01-15T00:00:00.000Z')
  })
})

// ─── NEW325: bookings crossing teacher-local midnight span two local dates ───

describe('isSlotAvailable — bookings crossing teacher-local midnight (NEW325)', () => {
  // Tokyo is UTC+9 (no DST): Wed Jun 10 00:00 JST = Jun 9 15:00Z, so the
  // post-midnight half of the booking sits on a different teacher-local date
  // than its own UTC date — a UTC-date-keyed implementation fails these.
  // (The Pacific/Auckland variants of these scenarios live in the NEW326 block
  // below — they additionally exercise the exactly-UTC+12 offset that
  // localTimeToUtcMs mis-resolved before its date-aware rewrite.)
  const CROSS_MIDNIGHT = [
    general(2, '23:00:00'),
    general(2, '23:30:00'), // Tue 23:00–24:00 JST
    general(3, '00:00:00'),
    general(3, '00:30:00'), // Wed 00:00–01:00 JST
  ]

  it('a 60-min general booking spanning two consecutive available days passes', async () => {
    // Tue Jun 9 23:30 JST = Jun 9 14:30Z; segments land Tue 23:30 and Wed 00:00
    // teacher-local. The old single-start-date slot build never generated the
    // Wednesday 00:00 slot and wrongly rejected what the display grid offers.
    await expect(check('Asia/Tokyo', CROSS_MIDNIGHT, '2026-06-09T14:30:00.000Z', 60)).resolves.toBe(true)
  })

  it('the same booking is rejected when the day it crosses INTO is a holiday', async () => {
    // Holiday date portion 2026-06-10 blocks the Wed 00:00 JST segment even
    // though the request STARTS on Tue Jun 9 — the old start-date-only holiday
    // check let this through.
    const records = [
      ...CROSS_MIDNIGHT,
      override('2026-06-10T00:00:00.000Z', '2026-06-10T23:59:59.999Z', { type: 'holiday' }),
    ]
    await expect(check('Asia/Tokyo', records, '2026-06-09T14:30:00.000Z', 60)).resolves.toBe(false)
  })

  it('a booking starting ON a holiday date is still rejected', async () => {
    // Wed Jun 10 07:00 JST = Jun 9 22:00Z — the teacher-local date (the
    // holiday), not the UTC date, drives the block.
    const wednesdayMorning = [general(3, '07:00:00'), general(3, '07:30:00')]
    await expect(check('Asia/Tokyo', wednesdayMorning, '2026-06-09T22:00:00.000Z', 60)).resolves.toBe(true)
    const records = [
      ...wednesdayMorning,
      override('2026-06-10T00:00:00.000Z', '2026-06-10T23:59:59.999Z', { type: 'holiday' }),
    ]
    await expect(check('Asia/Tokyo', records, '2026-06-09T22:00:00.000Z', 60)).resolves.toBe(false)
  })
})

// ─── NEW326: the NEW325 cross-midnight scenarios at exactly UTC+12 ───────────

describe('isSlotAvailable — cross-midnight at exactly UTC+12 (NEW325 × NEW326)', () => {
  // Auckland is UTC+12 in June (NZST, no DST): Tue Jun 9 23:30 NZST = Jun 9
  // 11:30Z and Wed Jun 10 00:00 NZST = Jun 9 12:00Z. Before NEW326 the
  // pre-midnight general slots (23:00/23:30 local) resolved a UTC day late, so
  // these scenarios could not even be expressed at this offset.
  const CROSS_MIDNIGHT = [
    general(2, '23:00:00'),
    general(2, '23:30:00'), // Tue 23:00–24:00 NZST
    general(3, '00:00:00'),
    general(3, '00:30:00'), // Wed 00:00–01:00 NZST
  ]

  it('a 60-min general booking spanning two consecutive available days passes', async () => {
    // Tue Jun 9 23:30 NZST; segments land Tue 23:30 (11:30Z) and Wed 00:00 (12:00Z).
    await expect(check('Pacific/Auckland', CROSS_MIDNIGHT, '2026-06-09T11:30:00.000Z', 60)).resolves.toBe(true)
  })

  it('the same booking is rejected when the day it crosses INTO is a holiday', async () => {
    const records = [
      ...CROSS_MIDNIGHT,
      override('2026-06-10T00:00:00.000Z', '2026-06-10T23:59:59.999Z', { type: 'holiday' }),
    ]
    await expect(check('Pacific/Auckland', records, '2026-06-09T11:30:00.000Z', 60)).resolves.toBe(false)
  })

  it('a booking starting ON a holiday date is still rejected', async () => {
    // Wed Jun 10 10:00 NZST = Jun 9 22:00Z — the teacher-local date (the
    // holiday), not the UTC date, drives the block.
    const wednesdayMorning = [general(3, '10:00:00'), general(3, '10:30:00')]
    await expect(check('Pacific/Auckland', wednesdayMorning, '2026-06-09T22:00:00.000Z', 60)).resolves.toBe(true)
    const records = [
      ...wednesdayMorning,
      override('2026-06-10T00:00:00.000Z', '2026-06-10T23:59:59.999Z', { type: 'holiday' }),
    ]
    await expect(check('Pacific/Auckland', records, '2026-06-09T22:00:00.000Z', 60)).resolves.toBe(false)
  })
})

// ─── Regression: general availability, holidays, timed blocks unchanged ──────

describe('isSlotAvailable — unchanged semantics', () => {
  it('plain general-availability booking passes, outside it fails', async () => {
    // Madrid Monday 10:00–11:00 CEST as two 30-min rows = Jun 8 08:00Z–09:00Z.
    const records = [general(1, '10:00:00'), general(1, '10:30:00')]
    await expect(check('Europe/Madrid', records, '2026-06-08T08:00:00.000Z', 60)).resolves.toBe(true)
    await expect(check('Europe/Madrid', records, '2026-06-08T09:00:00.000Z', 60)).resolves.toBe(false)
  })

  it('NEW175: general slot near UTC midnight resolves via the teacher-local date', async () => {
    // Tokyo Tuesday 07:00 JST = Monday Jun 8 22:00Z. The teacher-local date
    // (Jun 9, a Tuesday) drives the weekday and slot build, not the UTC date.
    const records = [general(2, '07:00:00')]
    await expect(check('Asia/Tokyo', records, '2026-06-08T22:00:00.000Z', 30)).resolves.toBe(true)
  })

  it('NEW174: a teacher-local holiday date still blocks a midnight-straddling add-override', async () => {
    // Holiday stored with date portion 2026-06-09 blocks the whole teacher-local
    // date; the overlapping add-override must not resurrect the slot.
    const records = [
      override('2026-06-08T22:00:00.000Z', '2026-06-09T01:00:00.000Z', { available: true }),
      override('2026-06-09T00:00:00.000Z', '2026-06-09T23:59:59.999Z', { type: 'holiday' }),
    ]
    await expect(check('Asia/Tokyo', records, '2026-06-09T00:00:00.000Z', 30)).resolves.toBe(false)
  })

  it('timed is_available=false override still blocks a general slot by instant overlap', async () => {
    const records = [
      general(1, '10:00:00'),
      override('2026-06-08T08:00:00.000Z', '2026-06-08T08:30:00.000Z'),
    ]
    await expect(check('Europe/Madrid', records, '2026-06-08T08:00:00.000Z', 30)).resolves.toBe(false)
  })
})

// ─── DST transitions: localTimeToUtcMs via the shared two-pass helper ────────
//
// localTimeToUtcMs is now a thin wrapper over wallTimeToUtcMs in
// @/lib/utils/timezone. Before that it carried its own SINGLE-pass probe — it
// read the offset at the wall clock reinterpreted as UTC, an instant up to 14
// hours from the answer, so a DST transition in between returned the wrong
// side's offset. Both the display grid (slotEngine.ts:146) and this write gate
// (availability.ts, the general-slot build) go through it, so the two agreed on
// the same wrong instant and the error was invisible until a teacher lost an
// hour of Sunday availability.
//
// 2026 transitions: Berlin/London spring 29 Mar 01:00Z, fall 25 Oct 01:00Z;
// New York spring 8 Mar 07:00Z, fall 1 Nov 06:00Z; Sydney spring 4 Oct
// (3 Oct 16:00Z), fall 5 Apr (4 Apr 16:00Z).

describe('localTimeToUtcMs — DST transition days', () => {
  const at = (dateStr: string, timeStr: string, tz: string) =>
    new Date(localTimeToUtcMs(dateStr, timeStr, tz)).toISOString()

  it('Europe/Berlin: spring gap shifts forward, fall-back repeat takes the first occurrence', () => {
    expect(at('2026-03-29', '00:30:00', 'Europe/Berlin')).toBe('2026-03-28T23:30:00.000Z')
    expect(at('2026-03-29', '02:30:00', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z') // gap
    expect(at('2026-03-29', '03:00:00', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z')
    expect(at('2026-10-25', '02:30:00', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z') // ambiguous
    expect(at('2026-10-25', '03:30:00', 'Europe/Berlin')).toBe('2026-10-25T02:30:00.000Z')
    expect(at('2026-06-15', '14:00:00', 'Europe/Berlin')).toBe('2026-06-15T12:00:00.000Z') // plain day
  })

  it('Europe/London: spring gap shifts forward, fall-back repeat takes the first occurrence', () => {
    expect(at('2026-03-29', '00:30:00', 'Europe/London')).toBe('2026-03-29T00:30:00.000Z')
    expect(at('2026-03-29', '01:30:00', 'Europe/London')).toBe('2026-03-29T01:30:00.000Z') // gap
    expect(at('2026-03-29', '02:00:00', 'Europe/London')).toBe('2026-03-29T01:00:00.000Z')
    expect(at('2026-10-25', '01:30:00', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z') // ambiguous
    expect(at('2026-10-25', '02:30:00', 'Europe/London')).toBe('2026-10-25T02:30:00.000Z')
    expect(at('2026-01-15', '09:00:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z') // plain day
  })

  it('America/New_York: the 03:00 spring-forward slot resolves to 07:00Z, not 08:00Z', () => {
    expect(at('2026-03-08', '01:30:00', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z')
    expect(at('2026-03-08', '02:30:00', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z') // gap
    expect(at('2026-03-08', '03:00:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z')
    expect(at('2026-03-08', '03:00:00', 'America/New_York')).not.toBe('2026-03-08T08:00:00.000Z')
    expect(at('2026-03-08', '09:00:00', 'America/New_York')).toBe('2026-03-08T13:00:00.000Z')
    expect(at('2026-11-01', '01:30:00', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z') // ambiguous
    expect(at('2026-11-01', '02:30:00', 'America/New_York')).toBe('2026-11-01T07:30:00.000Z')
    expect(at('2026-06-15', '09:00:00', 'America/New_York')).toBe('2026-06-15T13:00:00.000Z') // plain day
  })

  it('Australia/Sydney fails in BOTH directions under a single pass — both fixed', () => {
    // Spring (4 Oct): the old probe read +11 at 2026-10-04T01:00Z and returned
    // 2026-10-03T14:00:00Z — an hour early. The 01:00 wall clock is still AEST.
    expect(at('2026-10-04', '01:00:00', 'Australia/Sydney')).toBe('2026-10-03T15:00:00.000Z')
    expect(at('2026-10-04', '01:00:00', 'Australia/Sydney')).not.toBe('2026-10-03T14:00:00.000Z')
    expect(at('2026-10-04', '02:30:00', 'Australia/Sydney')).toBe('2026-10-03T16:30:00.000Z') // gap
    expect(at('2026-10-04', '03:00:00', 'Australia/Sydney')).toBe('2026-10-03T16:00:00.000Z')

    // Fall (5 Apr): the old probe read +10 at 2026-04-05T01:00Z and returned
    // 2026-04-04T15:00:00Z — an hour late. The 01:00 wall clock is still AEDT.
    expect(at('2026-04-05', '01:00:00', 'Australia/Sydney')).toBe('2026-04-04T14:00:00.000Z')
    expect(at('2026-04-05', '01:00:00', 'Australia/Sydney')).not.toBe('2026-04-04T15:00:00.000Z')
    expect(at('2026-04-05', '02:30:00', 'Australia/Sydney')).toBe('2026-04-04T15:30:00.000Z') // ambiguous
    expect(at('2026-04-05', '03:30:00', 'Australia/Sydney')).toBe('2026-04-04T17:30:00.000Z')

    expect(at('2026-06-15', '09:00:00', 'Australia/Sydney')).toBe('2026-06-14T23:00:00.000Z') // plain day
  })
})

// ─── DST transitions: the write gate end to end ──────────────────────────────

describe('isSlotAvailable — bookings on a DST transition day', () => {
  it('New York: the 03:00 EDT slot on spring-forward Sunday is accepted', () => {
    // Sun 8 Mar 2026. General availability 03:00-04:00 local = 07:00Z-08:00Z.
    // The single-pass probe built those slots at 08:00Z/08:30Z, so the gate
    // rejected the exact booking the display grid had offered at 07:00Z.
    const records = [general(0, '03:00:00'), general(0, '03:30:00')]
    return expect(check('America/New_York', records, '2026-03-08T07:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('New York: pre-transition EST hours on the same Sunday are unaffected', () => {
    // 01:00-02:00 EST = 06:00Z-07:00Z, entirely before the 07:00Z jump.
    const records = [general(0, '01:00:00'), general(0, '01:30:00')]
    return expect(check('America/New_York', records, '2026-03-08T06:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('New York: a booking one hour off the real slot is still rejected', () => {
    // Guards against "fix" by widening: 08:00Z is 04:00 EDT, outside 03:00-04:00.
    const records = [general(0, '03:00:00'), general(0, '03:30:00')]
    return expect(check('America/New_York', records, '2026-03-08T08:00:00.000Z', 60)).resolves.toBe(false)
  })

  it('Sydney: the 01:00 AEST slot on spring-forward Sunday is accepted', () => {
    // Sun 4 Oct 2026. 01:00-02:00 AEST = 3 Oct 15:00Z-16:00Z. The single-pass
    // probe placed these an hour early at 14:00Z/14:30Z.
    const records = [general(0, '01:00:00'), general(0, '01:30:00')]
    return expect(check('Australia/Sydney', records, '2026-10-03T15:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('Sydney: the 01:00 AEDT slot on fall-back Sunday is accepted', () => {
    // Sun 5 Apr 2026. 01:00-02:00 AEDT = 4 Apr 14:00Z-15:00Z. The single-pass
    // probe placed these an hour late at 15:00Z/15:30Z.
    const records = [general(0, '01:00:00'), general(0, '01:30:00')]
    return expect(check('Australia/Sydney', records, '2026-04-04T14:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('Europe/Berlin: a 60-min booking straddling the spring-forward jump is accepted', () => {
    // Sun 29 Mar 2026. Wall 01:30 CET (00:30Z) then 03:00 CEST (01:00Z) — two
    // consecutive real half hours despite the 90-minute wall-clock jump between them.
    const records = [general(0, '01:30:00'), general(0, '03:00:00')]
    return expect(check('Europe/Berlin', records, '2026-03-29T00:30:00.000Z', 60)).resolves.toBe(true)
  })
})

// ─── The invariant that must never break: grid and gate agree ────────────────
//
// The student booking grid (buildWeekSlots -> slotEngine.ts:146) and the write
// gate (isSlotAvailable -> availability.ts:135) build their general slots through
// the SAME primitive with the SAME teacher timezone, so a change to that primitive
// must move both in lockstep. If it ever does not, a student is offered a slot the
// gate then rejects at confirm — the exact NEW317/NEW322 failure class.
//
// A DST transition day is where that agreement is most fragile: the local day is
// 23 or 25 hours long, wall clocks collapse or repeat, and the two code paths reach
// the slot set by different routes (the grid pads teacher dates +/-1 and filters to
// a display window; the gate walks only the dates the request touches).

describe('slotEngine grid and isSlotAvailable gate agree on DST transition days', () => {
  // A teacher available 01:00-05:00 local every Sunday, as eight 30-min rows.
  const SUNDAY_1_TO_5 = ['01:00:00', '01:30:00', '02:00:00', '02:30:00',
                         '03:00:00', '03:30:00', '04:00:00', '04:30:00'].map((t) => general(0, t))
  // A teacher available 00:00-04:00 local every Sunday.
  const SUNDAY_0_TO_4 = ['00:00:00', '00:30:00', '01:00:00', '01:30:00',
                         '02:00:00', '02:30:00', '03:00:00', '03:30:00'].map((t) => general(0, t))

  function gridStarts(weekStart: string, tz: string, records: AvailabilityRecord[]): string[] {
    const byDay = buildWeekSlots({
      weekStart,
      displayTimezone: tz,
      teacherTimezone: tz,
      records,
      booked: [],
      // Well before the week, so neither the past nor the 24h rule blocks anything.
      nowMs: new Date(weekStart + 'T00:00:00.000Z').getTime() - 30 * 86_400_000,
      isAdmin: false,
    })
    return Object.values(byDay).flat().filter((s) => s.available).map((s) => s.startIso)
      .sort()
  }

  it('spring-forward Sunday (New York): the grid emits 6 instants over a 4h wall window, and the gate accepts every one', async () => {
    // Sun 8 Mar 2026, 01:00-05:00 EST/EDT. 02:00 and 02:30 do not exist and shift
    // forward onto 03:00/03:30, which the grid dedupes — so a 4-hour wall window
    // yields only 3 real hours. This is correct, not a lost hour.
    const starts = gridStarts('2026-03-02', 'America/New_York', SUNDAY_1_TO_5)
    expect(starts).toEqual([
      '2026-03-08T06:00:00.000Z',  // 01:00 EST
      '2026-03-08T06:30:00.000Z',  // 01:30 EST
      '2026-03-08T07:00:00.000Z',  // 03:00 EDT (02:00 collapsed onto it)
      '2026-03-08T07:30:00.000Z',  // 03:30 EDT (02:30 collapsed onto it)
      '2026-03-08T08:00:00.000Z',  // 04:00 EDT
      '2026-03-08T08:30:00.000Z',  // 04:30 EDT
    ])
    for (const startIso of starts) {
      await expect(check('America/New_York', SUNDAY_1_TO_5, startIso, 30), startIso).resolves.toBe(true)
    }
    // And the gate rejects the instants either side, which the grid did not offer.
    await expect(check('America/New_York', SUNDAY_1_TO_5, '2026-03-08T05:30:00.000Z', 30)).resolves.toBe(false)
    await expect(check('America/New_York', SUNDAY_1_TO_5, '2026-03-08T09:00:00.000Z', 30)).resolves.toBe(false)
  })

  it('fall-back Sunday (New York): the grid leaves a 90-min hole, and the gate refuses the same 60-min run', async () => {
    // Sun 1 Nov 2026, 00:00-04:00 EDT/EST. Wall 01:00 and 01:30 occur twice; the
    // contract takes the FIRST (EDT) occurrence, so the second pair (06:00Z, 06:30Z)
    // is never generated and the instant chain has a 90-minute hole.
    const starts = gridStarts('2026-10-26', 'America/New_York', SUNDAY_0_TO_4)
    expect(starts).toEqual([
      '2026-11-01T04:00:00.000Z',  // 00:00 EDT
      '2026-11-01T04:30:00.000Z',  // 00:30 EDT
      '2026-11-01T05:00:00.000Z',  // 01:00 EDT (first occurrence)
      '2026-11-01T05:30:00.000Z',  // 01:30 EDT (first occurrence)
      '2026-11-01T07:00:00.000Z',  // 02:00 EST  <- 90-min hole before this
      '2026-11-01T07:30:00.000Z',  // 02:30 EST
      '2026-11-01T08:00:00.000Z',  // 03:00 EST
      '2026-11-01T08:30:00.000Z',  // 03:30 EST
    ])
    for (const startIso of starts) {
      await expect(check('America/New_York', SUNDAY_0_TO_4, startIso, 30)).resolves.toBe(true)
    }

    // THE AGREEMENT THAT MATTERS. A 60-min run starting at the last slot before the
    // hole needs 05:30Z + 06:00Z; 06:00Z was never generated. The grid's own
    // bookable-start check and the write gate must BOTH refuse it — if they
    // disagreed, the student would see a bookable 60-min slot and be rejected at confirm.
    const availableStartMs = new Set(starts.map((s) => new Date(s).getTime()))
    expect(isBookableStart('2026-11-01T05:30:00.000Z', 2, availableStartMs)).toBe(false)
    await expect(check('America/New_York', SUNDAY_0_TO_4, '2026-11-01T05:30:00.000Z', 60)).resolves.toBe(false)

    // The slot on the far side of the hole starts a valid 60-min run in both.
    expect(isBookableStart('2026-11-01T07:00:00.000Z', 2, availableStartMs)).toBe(true)
    await expect(check('America/New_York', SUNDAY_0_TO_4, '2026-11-01T07:00:00.000Z', 60)).resolves.toBe(true)
  })

  it('every start the grid offers is accepted by the gate, across both Sydney transition weeks', async () => {
    // Southern hemisphere, and the zone whose slots the single-pass probe placed an
    // hour off in BOTH directions. Exhaustive over the emitted set, not spot checks.
    for (const weekStart of ['2026-09-28', '2026-03-30']) {
      const starts = gridStarts(weekStart, 'Australia/Sydney', SUNDAY_1_TO_5)
      expect(starts.length, weekStart).toBeGreaterThan(0)
      for (const startIso of starts) {
        await expect(
          check('Australia/Sydney', SUNDAY_1_TO_5, startIso, 30),
          `${weekStart} ${startIso}`,
        ).resolves.toBe(true)
      }
      // Instant chains are contiguous 30-min runs apart from the fall-back hole.
      const ms = starts.map((s) => new Date(s).getTime())
      const gaps = new Set(ms.slice(1).map((v, i) => (v - ms[i]) / 60_000))
      expect([...gaps].every((g) => g === 30 || g === 90), `${weekStart} gaps ${[...gaps]}`).toBe(true)
    }
  })
})

// ─── BOOK-SLOTCHECK-ERR-SWALLOWED: availability query error must throw ───────

describe('isSlotAvailable - availability query error', () => {
  it('throws when the availability lookup returns an error, instead of treating it as an empty list', async () => {
    const client = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { timezone: 'Europe/London' }, error: null }),
              }),
            }),
          }
        }
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
          }),
        }
      },
    } as unknown as AdminClient

    await expect(isSlotAvailable('teacher-1', '2026-09-01T10:00:00.000Z', 30, client)).rejects.toThrow(
      'availability lookup failed'
    )
  })
})
