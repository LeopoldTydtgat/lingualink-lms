import { describe, it, expect } from 'vitest'
import { getPresetRange } from './dateRangePresets'

const MADRID = 'Europe/Madrid'

// Pins the COMPOSITION, not the primitives. getDayKeyInTz, utcInstantToTzParts and
// addDaysToDateKey are each covered by monthRange.test.ts / timezone.test.ts; what is
// only asserted here is the way getPresetRange wires them together — the Monday-first
// rule (a Sunday maps BACK), the December -> January rollover, and month lengths being
// derived rather than tabulated. Each `now` below is written as a UTC instant with the
// intended local wall time named in the comment, so the fixture itself never depends on
// the machine's timezone.
describe('getPresetRange', () => {
  it('Europe/Madrid: week containing the 25-hour fall-back Sunday, from a Friday', () => {
    // Fri 23 Oct 2026 21:00 Madrid (+02:00). Madrid leaves DST at 03:00 local on
    // Sun 25 Oct, so that Sunday — the last day of this week — is 25 hours long.
    const now = new Date('2026-10-23T19:00:00Z')
    expect(getPresetRange('this_week', now, MADRID)).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    expect(getPresetRange('today', now, MADRID)).toEqual({ from: '2026-10-23', to: '2026-10-23' })
    expect(getPresetRange('this_month', now, MADRID)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(getPresetRange('last_month', now, MADRID)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('Europe/Madrid: a Sunday maps BACK to the Monday six days earlier, never forward', () => {
    // Sun 25 Oct 2026 13:00 Madrid — after the fall-back, so the offset is +01:00
    // and this instant sits in the repeated part of the day.
    const now = new Date('2026-10-25T12:00:00Z')
    expect(getPresetRange('this_week', now, MADRID)).toEqual({ from: '2026-10-19', to: '2026-10-25' })
  })

  it('one instant, two zones: the local day, month and week all differ', () => {
    // 1 Jan 2026 04:00Z = 17:00 on 1 Jan in Auckland (+13), 20:00 on 31 Dec in LA (-8).
    const now = new Date('2026-01-01T04:00:00Z')
    expect(getPresetRange('today', now, 'Pacific/Auckland')).toEqual({ from: '2026-01-01', to: '2026-01-01' })
    expect(getPresetRange('today', now, 'America/Los_Angeles')).toEqual({ from: '2025-12-31', to: '2025-12-31' })

    // January -> December rollover, and a month that is "this" in one zone and "last" in the other.
    expect(getPresetRange('last_month', now, 'Pacific/Auckland')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(getPresetRange('this_month', now, 'America/Los_Angeles')).toEqual({ from: '2025-12-01', to: '2025-12-31' })

    // Mon-Sun week spanning the year boundary.
    expect(getPresetRange('this_week', now, 'Pacific/Auckland')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
  })

  it('leap February is derived, not tabulated', () => {
    const now = new Date('2028-03-15T12:00:00Z')
    expect(getPresetRange('last_month', now, MADRID)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('America/Santiago: DST transition at midnight leaves calendar walking untouched', () => {
    // Santiago springs forward at 24:00 local, so the transition date has no 00:00 at
    // all. The preset never asks for midnight — it asks which date this instant is —
    // so the missing hour cannot reach it. 9 Sep 2026 11:00 Santiago (-04:00).
    const now = new Date('2026-09-09T15:00:00Z')
    expect(getPresetRange('this_week', now, 'America/Santiago')).toEqual({ from: '2026-09-07', to: '2026-09-13' })
  })

  it('Asia/Kathmandu (+05:45): a 45-minute offset still resolves the local day', () => {
    // 31 Aug 2026 18:30Z = 00:15 on 1 Sep in Kathmandu — a different day, month and
    // month-range than the UTC instant would suggest.
    const now = new Date('2026-08-31T18:30:00Z')
    expect(getPresetRange('today', now, 'Asia/Kathmandu')).toEqual({ from: '2026-09-01', to: '2026-09-01' })
    expect(getPresetRange('this_month', now, 'Asia/Kathmandu')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
})
