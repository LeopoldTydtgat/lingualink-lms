import { describe, it, expect } from 'vitest'
import { isSlotAvailable } from './availability'

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
