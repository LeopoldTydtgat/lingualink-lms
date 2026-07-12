import { describe, it, expect } from 'vitest'
import { localToUtc, getLocalDateKey, utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'

/**
 * Tests for src/lib/utils/timezone.ts — the single source of truth for
 * local-wall-clock → UTC conversion across the portal.
 *
 * Why this file exists: the +2h Madrid offset bug (NEW17/NEW70/NEW86) and the
 * recurring "lesson scheduled for the wrong UTC time" class of bugs all live
 * here. A wrong conversion silently corrupts lesson times in the DB. A
 * regression net of asserted in/out pairs is the only thing that catches it
 * deterministically — typecheck and a code reviewer cannot.
 *
 * Each case spells out (a) the wall-clock the user picked in their timezone
 * and (b) the UTC instant that wall-clock actually represents. If a future
 * change to localToUtc breaks any of these, CI fails and the bug never ships.
 *
 * Input contract per the source file:
 *   "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS". No Z. No offset.
 *   Interpreted as wall-clock time in the provided IANA timezone.
 */
describe('localToUtc', () => {
  // ── Europe/Madrid — the bug-history timezone ─────────────────────────────
  // CET = UTC+1 in winter (last Sun Oct → last Sun Mar).
  // CEST = UTC+2 in summer (last Sun Mar → last Sun Oct).

  it('Madrid winter (CET, UTC+1): 14:00 local → 13:00Z', () => {
    expect(localToUtc('2026-01-15T14:00', 'Europe/Madrid')).toBe('2026-01-15T13:00:00.000Z')
  })

  it('Madrid summer (CEST, UTC+2): 14:00 local → 12:00Z (the +2h bug case)', () => {
    expect(localToUtc('2026-07-15T14:00', 'Europe/Madrid')).toBe('2026-07-15T12:00:00.000Z')
  })

  // ── DST boundaries — historically where ad-hoc date math breaks ─────────
  // Europe/Madrid 2026 DST forward: 31 March 02:00 CET → 03:00 CEST.
  // A wall-clock of 03:00 on that morning is the FIRST instant of CEST,
  // which is the same UTC instant as 02:00 CET would have been. So 03:00 → 01:00Z.
  it('Madrid DST start (spring forward): 03:00 local on 2026-03-31 → 01:00Z', () => {
    // Note: the 02:00–03:00 hour is skipped. We pick 03:00 (a valid wall-clock).
    expect(localToUtc('2026-03-31T03:00', 'Europe/Madrid')).toBe('2026-03-31T01:00:00.000Z')
  })

  // Europe/Madrid 2026 DST back: 27 October 03:00 CEST → 02:00 CET.
  // The 02:00–03:00 hour is ambiguous (occurs twice). Intl's
  // two-pass probe should resolve it deterministically; we lock the result
  // here so a future change to the algorithm can't silently shift it.
  it('Madrid DST end (fall back): 04:00 local on 2026-10-27 → 03:00Z (unambiguous post-fallback hour)', () => {
    expect(localToUtc('2026-10-27T04:00', 'Europe/Madrid')).toBe('2026-10-27T03:00:00.000Z')
  })

  // ── Other production timezones the platform sees ─────────────────────────

  it('Africa/Johannesburg (SAST, UTC+2, no DST) winter: 09:00 → 07:00Z', () => {
    expect(localToUtc('2026-06-10T09:00', 'Africa/Johannesburg')).toBe('2026-06-10T07:00:00.000Z')
  })

  it('Africa/Johannesburg summer: 09:00 → 07:00Z (no DST shift)', () => {
    expect(localToUtc('2026-12-10T09:00', 'Africa/Johannesburg')).toBe('2026-12-10T07:00:00.000Z')
  })

  it('Europe/London (GMT, UTC+0) winter: 09:00 → 09:00Z', () => {
    expect(localToUtc('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z')
  })

  it('Europe/London (BST, UTC+1) summer: 09:00 → 08:00Z', () => {
    expect(localToUtc('2026-07-15T09:00', 'Europe/London')).toBe('2026-07-15T08:00:00.000Z')
  })

  it('UTC: identity — 14:00 local → 14:00Z', () => {
    expect(localToUtc('2026-05-15T14:00', 'UTC')).toBe('2026-05-15T14:00:00.000Z')
  })

  // ── Day boundaries — most ad-hoc date math breaks here ─────────────────
  // Madrid summer 01:00 wall-clock is 23:00 UTC on the PREVIOUS day. A naive
  // implementation that splits on the input date would store 2026-07-15 23:00
  // as 2026-07-15 23:00 UTC instead of 2026-07-14 23:00 UTC. Lock it.
  it('crosses date boundary backwards: Madrid summer 01:00 → 23:00Z previous day', () => {
    expect(localToUtc('2026-07-15T01:00', 'Europe/Madrid')).toBe('2026-07-14T23:00:00.000Z')
  })

  // Pacific/Auckland is UTC+12 (or +13 DST) — flips the date forward.
  it('crosses date boundary forwards: Auckland NZDT 09:00 → previous-day 20:00Z', () => {
    expect(localToUtc('2026-01-15T09:00', 'Pacific/Auckland')).toBe('2026-01-14T20:00:00.000Z')
  })

  // ── Midnight ─────────────────────────────────────────────────────────────
  // Used by monthRange.ts (start/end of month). Mistakes here have produced
  // wrong-month billing aggregates before.

  it('midnight Madrid winter: 00:00 local → 23:00Z previous day', () => {
    expect(localToUtc('2026-02-01T00:00', 'Europe/Madrid')).toBe('2026-01-31T23:00:00.000Z')
  })

  it('midnight Madrid summer: 00:00 local → 22:00Z previous day', () => {
    expect(localToUtc('2026-08-01T00:00', 'Europe/Madrid')).toBe('2026-07-31T22:00:00.000Z')
  })

  // ── Input contract ──────────────────────────────────────────────────────

  it('output is always a valid ISO string with Z suffix', () => {
    const result = localToUtc('2026-05-15T14:00', 'Europe/Madrid')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  // Some call sites (e.g. monthRange's internal probe) pass YYYY-MM-DDTHH:MM:SS.
  // The function splits on /[-T:]/ so seconds are accepted; verify.
  it('accepts YYYY-MM-DDTHH:MM:SS input form', () => {
    // Seconds are consumed by the split but not preserved in the numeric parse
    // (only the first 5 fields y/mo/d/h/min are read). Same minute, same result.
    expect(localToUtc('2026-07-15T14:00:00', 'Europe/Madrid'))
      .toBe(localToUtc('2026-07-15T14:00', 'Europe/Madrid'))
  })

  // ── Round-trip sanity: UTC → local-wall → UTC = original ────────────────
  // If you can re-derive the same UTC instant from the local wall-clock that
  // the timezone formatter says it is, the conversion is consistent.
  it('round-trip stable for several timezones', () => {
    const tzs = ['Europe/Madrid', 'Europe/London', 'Africa/Johannesburg', 'Pacific/Auckland', 'America/New_York']
    const utcOriginal = '2026-07-15T11:30:00.000Z'
    for (const tz of tzs) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(utcOriginal))
      const get = (t: string) => parts.find(p => p.type === t)!.value
      // Build the naive local ISO that Intl says this UTC is.
      const localIso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
      expect(localToUtc(localIso, tz)).toBe(utcOriginal)
    }
  })
})

// ─── getLocalDateKey ──────────────────────────────────────────────────────────

describe('getLocalDateKey', () => {
  it('positive-offset: UTC midnight on a date stays on the same calendar date', () => {
    // 2026-06-08T00:00Z in SAST (UTC+2) = 02:00 SAST same day → "2026-06-08"
    expect(getLocalDateKey(new Date('2026-06-08T00:00:00Z'), 'Africa/Johannesburg')).toBe('2026-06-08')
  })

  it('positive-offset: browser local Monday midnight (Sunday 22:00 UTC) reads as Monday', () => {
    // Monday 8 Jun 2026 00:00 SAST = 2026-06-07T22:00Z; must resolve to "2026-06-08" not "2026-06-07"
    expect(getLocalDateKey(new Date('2026-06-07T22:00:00Z'), 'Africa/Johannesburg')).toBe('2026-06-08')
  })

  it('UTC: same moment reads as Sunday, exposing the pre-fix bug', () => {
    // The old code passed "UTC" here — 2026-06-07T22:00Z in UTC is "2026-06-07" (Sunday)
    expect(getLocalDateKey(new Date('2026-06-07T22:00:00Z'), 'UTC')).toBe('2026-06-07')
  })

  it('negative-offset: Monday midnight EDT stays Monday', () => {
    // Monday 8 Jun 2026 00:00 EDT (UTC-4) = 2026-06-08T04:00Z → "2026-06-08"
    expect(getLocalDateKey(new Date('2026-06-08T04:00:00Z'), 'America/New_York')).toBe('2026-06-08')
  })
})

// ─── Booking availability — week keying alignment ─────────────────────────────
//
// Regression guard for the bug where the client's Sunday column was always blank
// for positive-offset browsers (Europe/Madrid, Africa/Johannesburg).
//
// ROOT CAUSE: BookingClient formatted weekStart (browser-local Monday midnight)
// in 'UTC', which for UTC+2 browsers rolled it back to Sunday — giving the server
// a Sun-Sat anchor while the client displayed Mon-Sun. The fix formats in
// studentTimezone so both sides use the same Monday anchor.

describe('booking availability — week keying alignment', () => {
  // Mirrors route.ts:72-79 + 203-208: treat param as UTC midnight, step by UTC
  // day, then re-express each anchor in the student tz (the emitted slotsByDate key).
  function buildServerKeys(weekStartParam: string, studentTz: string): string[] {
    const base = new Date(weekStartParam + 'T00:00:00.000Z')
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base)
      d.setUTCDate(d.getUTCDate() + i)
      return getLocalDateKey(d, studentTz)
    })
  }

  // Mirrors BookingClient weekDays loop + column lookup (line 618): add calendar
  // days from weekStart and format in student tz. SAST has no DST so +86400000ms
  // = exactly one local day — safe to use for deterministic testing.
  function buildClientKeys(weekStart: Date, studentTz: string): string[] {
    return Array.from({ length: 7 }, (_, i) =>
      getLocalDateKey(new Date(weekStart.getTime() + i * 86400000), studentTz)
    )
  }

  // Africa/Johannesburg (SAST, UTC+2, no DST) — our primary user timezone.
  // Monday 8 Jun 2026 00:00 SAST = 2026-06-07T22:00:00Z (Sunday evening in UTC).
  const studentTz = 'Africa/Johannesburg'
  const weekStart = new Date('2026-06-07T22:00:00Z')

  it('OLD param ("UTC"): sends Sunday anchor → server covers Sun–Sat, client Sunday column "2026-06-14" missing', () => {
    const oldParam = getLocalDateKey(weekStart, 'UTC')
    expect(oldParam).toBe('2026-06-07')  // Sunday — wrong anchor

    const serverKeys = buildServerKeys(oldParam, studentTz)
    // Server covers Sun 7 Jun through Sat 13 Jun
    expect(serverKeys).toEqual([
      '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10',
      '2026-06-11', '2026-06-12', '2026-06-13',
    ])

    // Client's last column (Sunday 14 Jun) is not in the server response → blank
    const clientLastKey = buildClientKeys(weekStart, studentTz)[6]
    expect(clientLastKey).toBe('2026-06-14')
    expect(serverKeys).not.toContain(clientLastKey)
  })

  it('FIXED param (studentTz): sends Monday anchor → server covers Mon–Sun, all 7 client keys match', () => {
    const param = getLocalDateKey(weekStart, studentTz)
    expect(param).toBe('2026-06-08')  // Monday — correct anchor

    const serverKeys = buildServerKeys(param, studentTz)
    expect(serverKeys).toEqual([
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11',
      '2026-06-12', '2026-06-13', '2026-06-14',
    ])

    const clientKeys = buildClientKeys(weekStart, studentTz)
    expect(clientKeys).toEqual(serverKeys)            // exact 7-key match
    expect(serverKeys).toContain(clientKeys[6])       // Sunday column is not blank
  })

  it('America/New_York (UTC-4 EDT in June): fix does not regress negative-offset browsers', () => {
    // Monday midnight EDT = 2026-06-08T04:00Z; 04:00Z is still Monday in UTC,
    // so old code ("UTC") and new code (studentTz) both produce "2026-06-08".
    // The fix changes nothing for negative-offset browsers.
    const weekStartNYC = new Date('2026-06-08T04:00:00Z')
    const fixedParam   = getLocalDateKey(weekStartNYC, 'America/New_York')
    const oldParam     = getLocalDateKey(weekStartNYC, 'UTC')
    expect(fixedParam).toBe('2026-06-08')
    expect(oldParam).toBe('2026-06-08')
    expect(fixedParam).toBe(oldParam)  // identical — no regression
  })
})

// ─── utcInstantToTzParts ──────────────────────────────────────────────────────
//
// The render frame of the teacher Day to Day calendar: every stored UTC instant
// (availability start_at/end_at, lesson scheduled_at, the now tick) is turned
// into profile-tz wall-clock parts through this function. A wrong part here
// draws a block at the wrong grid position for every viewer — the exact
// mixed-frame bug class this helper exists to close.

describe('utcInstantToTzParts', () => {
  it('UTC identity: parts equal the instant’s own UTC fields', () => {
    expect(utcInstantToTzParts('2026-07-15T14:30:00Z', 'UTC')).toEqual({
      year: 2026, month: 7, day: 15, hour: 14, minute: 30, weekday: 3, // 2026-07-15 is a Wednesday
    })
  })

  it('positive offset (Asia/Tokyo, UTC+9, no DST): crosses the date boundary forward', () => {
    // 2026-07-15T22:30Z = 2026-07-16 07:30 in Tokyo — next calendar day, Thursday.
    expect(utcInstantToTzParts('2026-07-15T22:30:00Z', 'Asia/Tokyo')).toEqual({
      year: 2026, month: 7, day: 16, hour: 7, minute: 30, weekday: 4,
    })
  })

  it('negative offset (America/New_York, EDT UTC-4): crosses the date boundary backward', () => {
    // 2026-07-15T02:00Z = 2026-07-14 22:00 EDT — previous calendar day, Tuesday.
    expect(utcInstantToTzParts('2026-07-15T02:00:00Z', 'America/New_York')).toEqual({
      year: 2026, month: 7, day: 14, hour: 22, minute: 0, weekday: 2,
    })
  })

  // US spring-forward: America/New_York, Sunday 2026-03-08, 02:00 EST → 03:00 EDT.
  it('US DST spring-forward: one minute before the jump is 01:59 EST', () => {
    expect(utcInstantToTzParts('2026-03-08T06:59:00Z', 'America/New_York')).toEqual({
      year: 2026, month: 3, day: 8, hour: 1, minute: 59, weekday: 0,
    })
  })

  it('US DST spring-forward: the jump instant reads 03:00 EDT (02:xx never exists)', () => {
    expect(utcInstantToTzParts('2026-03-08T07:00:00Z', 'America/New_York')).toEqual({
      year: 2026, month: 3, day: 8, hour: 3, minute: 0, weekday: 0,
    })
  })

  // EU fall-back: Europe/Brussels, Sunday 2026-10-25, 03:00 CEST → 02:00 CET.
  it('EU DST fall-back: one minute before the repeat is 02:59 CEST', () => {
    expect(utcInstantToTzParts('2026-10-25T00:59:00Z', 'Europe/Brussels')).toEqual({
      year: 2026, month: 10, day: 25, hour: 2, minute: 59, weekday: 0,
    })
  })

  it('EU DST fall-back: the repeat instant reads 02:00 again (CET this time)', () => {
    expect(utcInstantToTzParts('2026-10-25T01:00:00Z', 'Europe/Brussels')).toEqual({
      year: 2026, month: 10, day: 25, hour: 2, minute: 0, weekday: 0,
    })
  })

  it('midnight in the target zone reports hour 0, never 24', () => {
    // 2026-06-09T22:00Z = 2026-06-10 00:00 SAST (UTC+2). Also exercises the
    // hour-"24" ICU normalisation path behaviourally.
    expect(utcInstantToTzParts('2026-06-09T22:00:00Z', 'Africa/Johannesburg')).toEqual({
      year: 2026, month: 6, day: 10, hour: 0, minute: 0, weekday: 3,
    })
  })

  it('accepts a Date object as well as an ISO string', () => {
    const iso = '2026-07-15T14:30:00Z'
    expect(utcInstantToTzParts(new Date(iso), 'Europe/Madrid'))
      .toEqual(utcInstantToTzParts(iso, 'Europe/Madrid'))
  })

  it('round-trips with localToUtc: parts re-encoded through the same tz give the original instant', () => {
    const tzs = ['Europe/Madrid', 'Africa/Johannesburg', 'America/New_York', 'Asia/Tokyo', 'Pacific/Auckland']
    const utcOriginal = '2026-07-15T11:30:00.000Z'
    for (const tz of tzs) {
      const p = utcInstantToTzParts(utcOriginal, tz)
      const localIso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
      expect(localToUtc(localIso, tz)).toBe(utcOriginal)
    }
  })

  it('throws on an invalid timezone (Intl behaviour — callers must guard)', () => {
    expect(() => utcInstantToTzParts('2026-07-15T14:30:00Z', 'Not/AZone')).toThrow(RangeError)
  })
})

// ─── isValidTimeZone ──────────────────────────────────────────────────────────

describe('isValidTimeZone', () => {
  it('accepts real IANA identifiers and UTC', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true)
    expect(isValidTimeZone('Africa/Johannesburg')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects garbage, empty, and whitespace-padded values', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(' Europe/Madrid')).toBe(false)
  })
})
