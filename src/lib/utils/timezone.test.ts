import { describe, it, expect } from 'vitest'
import {
  localToUtc,
  getLocalDateKey,
  utcInstantToTzParts,
  isValidTimeZone,
  wallTimeToUtcMs,
  addDaysToDateKey,
} from '@/lib/utils/timezone'

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

  // ── Post-DST-boundary days ───────────────────────────────────────────────
  // CORRECTED: these two cases were labelled as the transition days themselves,
  // but Europe/Madrid's 2026 transitions are Sunday 29 March and Sunday 25
  // October (last Sunday of the month, 01:00Z) — 31 March and 27 October are
  // both TUESDAYS, ordinary CEST and CET days respectively. The assertions are
  // right; only the old comments were wrong, and they contradicted the correct
  // transition table further down this file. They are kept as plain
  // summer-offset / winter-offset checks either side of a transition. The real
  // transition-day coverage lives in the wallTimeToUtcMs blocks below.
  it('Madrid two days after DST start: 03:00 local on 2026-03-31 → 01:00Z (CEST, +2)', () => {
    expect(localToUtc('2026-03-31T03:00', 'Europe/Madrid')).toBe('2026-03-31T01:00:00.000Z')
  })

  it('Madrid two days after DST end: 04:00 local on 2026-10-27 → 03:00Z (CET, +1)', () => {
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

// ─── wallTimeToUtcMs — the shared DST-correct two-pass probe ──────────────────
//
// Every local-wall-clock → UTC conversion in the project funnels through this
// one function: localToUtc above, localTimeToUtcMs (src/lib/availability.ts) and
// localMidnightToUtc (src/lib/billing/monthRange.ts) are thin wrappers over it.
//
// Before this net existed, all three carried their OWN single-pass probe (each
// with a docstring falsely claiming two passes). A single pass reads the offset
// at the wall clock reinterpreted as UTC — an instant up to 14 hours away from
// the answer — so any DST transition falling in between returns the wrong side's
// offset. The America/New_York 03:00 case below is the production failure: the
// booking gate lost an hour of general availability on every spring-forward day
// and resolved the rest of that day's slots one hour off.
//
// 2026 transitions used throughout, from the IANA rules:
//   Europe/Berlin, Europe/London, Europe/Madrid  spring  Sun 29 Mar, 01:00Z
//                                                fall    Sun 25 Oct, 01:00Z
//   America/New_York                             spring  Sun  8 Mar, 07:00Z
//                                                fall    Sun  1 Nov, 06:00Z
//   Australia/Sydney                             spring  Sun  4 Oct (03 Oct 16:00Z)
//                                                fall    Sun  5 Apr (04 Apr 16:00Z)

const at = (y: number, mo: number, d: number, h: number, mi: number, tz: string) =>
  new Date(wallTimeToUtcMs(y, mo, d, h, mi, tz)).toISOString()

describe('wallTimeToUtcMs — deltas and offsets outside the common 1h / ±12h case', () => {
  // The four production zones all have a 1-hour DST delta and an offset inside
  // ±12. Nothing above proves the algorithm generalises. These do — each is a
  // shape that a naive implementation gets wrong in a different way.
  const wallAt = (iso: string, tz: string) => {
    const p = utcInstantToTzParts(iso, tz)
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  }

  it('30-minute DST delta (Australia/Lord_Howe): the gap is half an hour, not a whole one', () => {
    // Lord Howe springs forward 2026-10-04 02:00 -> 02:30. Only 02:00-02:29 is
    // nonexistent, so 02:00 shifts forward by 30 min and 02:30 is already real.
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 10, 4, 2, 0, 'Australia/Lord_Howe')).toISOString(), 'Australia/Lord_Howe')).toBe('02:30')
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 10, 4, 2, 30, 'Australia/Lord_Howe')).toISOString(), 'Australia/Lord_Howe')).toBe('02:30')
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 10, 4, 1, 30, 'Australia/Lord_Howe')).toISOString(), 'Australia/Lord_Howe')).toBe('01:30')
  })

  it('45-minute offset zone (Pacific/Chatham, +12:45 / +13:45)', () => {
    // Chatham springs forward 2026-09-27 02:45 -> 03:45, so 03:00 is IN the gap.
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 9, 27, 3, 0, 'Pacific/Chatham')).toISOString(), 'Pacific/Chatham')).toBe('04:00')
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 9, 27, 2, 30, 'Pacific/Chatham')).toISOString(), 'Pacific/Chatham')).toBe('02:30')
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 9, 27, 12, 0, 'Pacific/Chatham')).toISOString(), 'Pacific/Chatham')).toBe('12:00')
  })

  it('2-hour DST delta (Antarctica/Troll, +00 -> +02): the gap is two hours wide', () => {
    // Every wall clock in 01:00-02:59 is nonexistent and shifts forward by 2h.
    for (const [h, mi, want] of [[1, 0, '03:00'], [1, 30, '03:30'], [2, 0, '04:00'], [2, 30, '04:30']] as [number, number, string][]) {
      expect(wallAt(new Date(wallTimeToUtcMs(2026, 3, 29, h, mi, 'Antarctica/Troll')).toISOString(), 'Antarctica/Troll'), `${h}:${mi}`).toBe(want)
    }
    expect(wallAt(new Date(wallTimeToUtcMs(2026, 3, 29, 3, 0, 'Antarctica/Troll')).toISOString(), 'Antarctica/Troll')).toBe('03:00')
  })

  it('offsets beyond +13 (Pacific/Kiritimati +14, Pacific/Apia +13) round-trip exactly', () => {
    // +14 is the widest real offset, so wallAsUtcMs and the answer are 14h apart —
    // the largest span the ±24h bracket has to cover.
    expect(new Date(wallTimeToUtcMs(2026, 6, 15, 9, 0, 'Pacific/Kiritimati')).toISOString())
      .toBe('2026-06-14T19:00:00.000Z')
    expect(new Date(wallTimeToUtcMs(2026, 6, 15, 9, 0, 'Pacific/Apia')).toISOString())
      .toBe('2026-06-14T20:00:00.000Z')
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Apia']) {
      for (const h of [0, 6, 12, 23]) {
        expect(wallAt(new Date(wallTimeToUtcMs(2026, 6, 15, h, 30, tz)).toISOString(), tz), `${tz} ${h}`)
          .toBe(`${String(h).padStart(2, '0')}:30`)
      }
    }
  })
})

describe('wallTimeToUtcMs — formatter cache behaviour', () => {
  it('case variants of a zone name agree, and an invalid tz throws every time (never cached)', () => {
    // Intl matches IANA names case-insensitively and tz arrives from a
    // user-supplied ?timezone= param, so the cache keys on the lower-cased name.
    // Observable contract: the answer must not depend on the casing.
    const expected = at(2026, 3, 29, 2, 30, 'Europe/Madrid')
    for (const variant of ['europe/madrid', 'EUROPE/MADRID', 'Europe/madrid', 'eUrOpE/MaDrId']) {
      expect(at(2026, 3, 29, 2, 30, variant), variant).toBe(expected)
    }
    // A failed construction must not poison the cache or start succeeding.
    for (let i = 0; i < 3; i++) {
      expect(() => wallTimeToUtcMs(2026, 6, 15, 12, 0, 'Not/AZone')).toThrow(RangeError)
    }
    expect(at(2026, 6, 15, 12, 0, 'Europe/Madrid')).toBe('2026-06-15T10:00:00.000Z')
  })

  it('stays correct after the bounded cache is flushed by many distinct zones', () => {
    // MAX_CACHED_FORMATTERS is 64; walk well past it, then re-check a known answer.
    const zones = Intl.supportedValuesOf('timeZone').slice(0, 200)
    for (const tz of zones) wallTimeToUtcMs(2026, 6, 15, 12, 0, tz)
    expect(at(2026, 3, 8, 3, 0, 'America/New_York')).toBe('2026-03-08T07:00:00.000Z')
    expect(at(2026, 10, 4, 2, 30, 'Australia/Sydney')).toBe('2026-10-03T16:30:00.000Z')
  })
})

describe('wallTimeToUtcMs — Europe/Berlin (CET +1 / CEST +2)', () => {
  const TZ = 'Europe/Berlin'

  it('plain non-transition day (June, CEST) converts at a flat +2', () => {
    expect(at(2026, 6, 15, 0, 0, TZ)).toBe('2026-06-14T22:00:00.000Z')
    expect(at(2026, 6, 15, 14, 0, TZ)).toBe('2026-06-15T12:00:00.000Z')
    expect(at(2026, 6, 15, 23, 30, TZ)).toBe('2026-06-15T21:30:00.000Z')
  })

  it('plain non-transition day (January, CET) converts at a flat +1', () => {
    expect(at(2026, 1, 15, 14, 0, TZ)).toBe('2026-01-15T13:00:00.000Z')
  })

  // 29 Mar 2026: 02:00 CET → 03:00 CEST. The 02:00–03:00 wall hour never happens.
  it('spring forward: before / inside / after the gap', () => {
    expect(at(2026, 3, 29, 0, 30, TZ)).toBe('2026-03-28T23:30:00.000Z')  // CET, before
    expect(at(2026, 3, 29, 1, 59, TZ)).toBe('2026-03-29T00:59:00.000Z')  // CET, last real minute
    expect(at(2026, 3, 29, 2, 30, TZ)).toBe('2026-03-29T01:30:00.000Z')  // GAP → 03:30 CEST
    expect(at(2026, 3, 29, 3, 0, TZ)).toBe('2026-03-29T01:00:00.000Z')   // CEST, first instant
    expect(at(2026, 3, 29, 12, 0, TZ)).toBe('2026-03-29T10:00:00.000Z')  // CEST, after
  })

  it('spring forward: a nonexistent wall time resolves FORWARD past the gap', () => {
    // Documented contract: 02:30 does not exist, so it means 03:30 CEST — the same
    // instant you reach by adding the 1h gap. It must never fall back to 01:30 CET.
    expect(utcInstantToTzParts(at(2026, 3, 29, 2, 30, TZ), TZ))
      .toMatchObject({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 })
  })

  // 25 Oct 2026: 03:00 CEST → 02:00 CET. The 02:00–03:00 wall hour happens twice.
  it('fall back: before / inside / after the repeated hour', () => {
    expect(at(2026, 10, 25, 0, 30, TZ)).toBe('2026-10-24T22:30:00.000Z')  // CEST, before
    expect(at(2026, 10, 25, 1, 30, TZ)).toBe('2026-10-24T23:30:00.000Z')  // CEST, unambiguous
    expect(at(2026, 10, 25, 2, 30, TZ)).toBe('2026-10-25T00:30:00.000Z')  // AMBIGUOUS → first
    expect(at(2026, 10, 25, 3, 30, TZ)).toBe('2026-10-25T02:30:00.000Z')  // CET, after
    expect(at(2026, 10, 25, 12, 0, TZ)).toBe('2026-10-25T11:00:00.000Z')  // CET, after
  })

  it('fall back: an ambiguous wall time resolves to the FIRST occurrence', () => {
    // 02:30 exists twice: 00:30Z (CEST) and 01:30Z (CET). Contract picks the earlier.
    const chosen = at(2026, 10, 25, 2, 30, TZ)
    expect(chosen).toBe('2026-10-25T00:30:00.000Z')
    expect(new Date(chosen).getTime()).toBeLessThan(new Date('2026-10-25T01:30:00.000Z').getTime())
    // Both instants really do read 02:30 in Berlin — the choice is genuine, not luck.
    expect(utcInstantToTzParts(chosen, TZ)).toMatchObject({ hour: 2, minute: 30 })
    expect(utcInstantToTzParts('2026-10-25T01:30:00.000Z', TZ)).toMatchObject({ hour: 2, minute: 30 })
  })
})

describe('wallTimeToUtcMs — Europe/London (GMT +0 / BST +1)', () => {
  const TZ = 'Europe/London'

  it('plain non-transition days', () => {
    expect(at(2026, 1, 15, 9, 0, TZ)).toBe('2026-01-15T09:00:00.000Z')   // GMT
    expect(at(2026, 7, 15, 9, 0, TZ)).toBe('2026-07-15T08:00:00.000Z')   // BST
  })

  // 29 Mar 2026: 01:00 GMT → 02:00 BST. The 01:00–02:00 wall hour never happens.
  it('spring forward: before / inside / after the gap', () => {
    expect(at(2026, 3, 29, 0, 30, TZ)).toBe('2026-03-29T00:30:00.000Z')  // GMT, before
    expect(at(2026, 3, 29, 1, 30, TZ)).toBe('2026-03-29T01:30:00.000Z')  // GAP → 02:30 BST
    expect(at(2026, 3, 29, 2, 0, TZ)).toBe('2026-03-29T01:00:00.000Z')   // BST, first instant
    expect(at(2026, 3, 29, 12, 0, TZ)).toBe('2026-03-29T11:00:00.000Z')  // BST, after
    expect(utcInstantToTzParts(at(2026, 3, 29, 1, 30, TZ), TZ))
      .toMatchObject({ day: 29, hour: 2, minute: 30 })
  })

  // 25 Oct 2026: 02:00 BST → 01:00 GMT. The 01:00–02:00 wall hour happens twice.
  it('fall back: before / inside / after the repeated hour', () => {
    expect(at(2026, 10, 25, 0, 30, TZ)).toBe('2026-10-24T23:30:00.000Z')  // BST, before
    expect(at(2026, 10, 25, 1, 30, TZ)).toBe('2026-10-25T00:30:00.000Z')  // AMBIGUOUS → first
    expect(at(2026, 10, 25, 2, 30, TZ)).toBe('2026-10-25T02:30:00.000Z')  // GMT, after
    expect(at(2026, 10, 25, 12, 0, TZ)).toBe('2026-10-25T12:00:00.000Z')  // GMT, after
  })
})

describe('wallTimeToUtcMs — America/New_York (EST -5 / EDT -4)', () => {
  const TZ = 'America/New_York'

  it('plain non-transition days', () => {
    expect(at(2026, 6, 15, 9, 0, TZ)).toBe('2026-06-15T13:00:00.000Z')   // EDT
    expect(at(2026, 1, 15, 9, 0, TZ)).toBe('2026-01-15T14:00:00.000Z')   // EST
  })

  // 8 Mar 2026: 02:00 EST → 03:00 EDT (07:00Z). THE headline regression.
  it('spring forward: 03:00 local is 07:00Z, not the single-pass probe’s 08:00Z', () => {
    // The old probe read the offset at 03:00Z, which is still 22:00 EST on Mar 7,
    // so it applied -5h and returned 08:00Z — every slot from 03:00 onward on that
    // Sunday was written and gated an hour late.
    expect(at(2026, 3, 8, 3, 0, TZ)).toBe('2026-03-08T07:00:00.000Z')
    expect(at(2026, 3, 8, 3, 0, TZ)).not.toBe('2026-03-08T08:00:00.000Z')
  })

  it('spring forward: before / inside / after the gap', () => {
    expect(at(2026, 3, 8, 1, 30, TZ)).toBe('2026-03-08T06:30:00.000Z')   // EST, before
    expect(at(2026, 3, 8, 1, 59, TZ)).toBe('2026-03-08T06:59:00.000Z')   // EST, last real minute
    expect(at(2026, 3, 8, 2, 30, TZ)).toBe('2026-03-08T07:30:00.000Z')   // GAP → 03:30 EDT
    expect(at(2026, 3, 8, 3, 30, TZ)).toBe('2026-03-08T07:30:00.000Z')   // EDT, same instant
    expect(at(2026, 3, 8, 9, 0, TZ)).toBe('2026-03-08T13:00:00.000Z')    // EDT, after
    expect(at(2026, 3, 8, 23, 30, TZ)).toBe('2026-03-09T03:30:00.000Z')  // EDT, crosses UTC midnight
  })

  // 1 Nov 2026: 02:00 EDT → 01:00 EST (06:00Z).
  it('fall back: before / inside / after the repeated hour', () => {
    expect(at(2026, 11, 1, 0, 30, TZ)).toBe('2026-11-01T04:30:00.000Z')  // EDT, before
    expect(at(2026, 11, 1, 1, 30, TZ)).toBe('2026-11-01T05:30:00.000Z')  // AMBIGUOUS → first
    expect(at(2026, 11, 1, 2, 30, TZ)).toBe('2026-11-01T07:30:00.000Z')  // EST, after
    expect(at(2026, 11, 1, 12, 0, TZ)).toBe('2026-11-01T17:00:00.000Z')  // EST, after
  })
})

describe('wallTimeToUtcMs — Australia/Sydney (AEST +10 / AEDT +11)', () => {
  const TZ = 'Australia/Sydney'

  it('plain non-transition days', () => {
    expect(at(2026, 6, 15, 9, 0, TZ)).toBe('2026-06-14T23:00:00.000Z')   // AEST
    expect(at(2026, 1, 15, 9, 0, TZ)).toBe('2026-01-14T22:00:00.000Z')   // AEDT
  })

  // Southern hemisphere: DST STARTS 4 Oct 2026, 02:00 AEST → 03:00 AEDT (3 Oct 16:00Z).
  it('spring forward (October): before / inside / after the gap', () => {
    expect(at(2026, 10, 4, 1, 30, TZ)).toBe('2026-10-03T15:30:00.000Z')  // AEST, before
    expect(at(2026, 10, 4, 2, 30, TZ)).toBe('2026-10-03T16:30:00.000Z')  // GAP → 03:30 AEDT
    expect(at(2026, 10, 4, 3, 0, TZ)).toBe('2026-10-03T16:00:00.000Z')   // AEDT, first instant
    expect(at(2026, 10, 4, 12, 0, TZ)).toBe('2026-10-04T01:00:00.000Z')  // AEDT, after
    expect(utcInstantToTzParts(at(2026, 10, 4, 2, 30, TZ), TZ))
      .toMatchObject({ day: 4, hour: 3, minute: 30 })
  })

  // DST ENDS 5 Apr 2026, 03:00 AEDT → 02:00 AEST (4 Apr 16:00Z).
  it('fall back (April): before / inside / after the repeated hour', () => {
    expect(at(2026, 4, 5, 1, 30, TZ)).toBe('2026-04-04T14:30:00.000Z')   // AEDT, before
    expect(at(2026, 4, 5, 2, 30, TZ)).toBe('2026-04-04T15:30:00.000Z')   // AMBIGUOUS → first
    expect(at(2026, 4, 5, 3, 30, TZ)).toBe('2026-04-04T17:30:00.000Z')   // AEST, after
    expect(at(2026, 4, 5, 12, 0, TZ)).toBe('2026-04-05T02:00:00.000Z')   // AEST, after
  })

  it('the ambiguity rule is hemisphere-independent — earlier instant, same as the north', () => {
    // A naive "re-probe at the candidate" two-pass picks the LATER occurrence in the
    // southern hemisphere and the EARLIER one in the northern. Both must be earlier.
    expect(at(2026, 4, 5, 2, 30, TZ)).toBe('2026-04-04T15:30:00.000Z')
    expect(new Date(at(2026, 4, 5, 2, 30, TZ)).getTime())
      .toBeLessThan(new Date('2026-04-04T16:30:00.000Z').getTime())
    expect(utcInstantToTzParts('2026-04-04T16:30:00.000Z', TZ)).toMatchObject({ hour: 2, minute: 30 })
  })
})

// ─── Whole-week instant chains, and the round-trip that actually catches it ──
//
// Take the 48 half-hour wall clocks of a local calendar day and convert each one.
// A normal day yields 48 distinct UTC instants exactly 30 min apart. A
// spring-forward day is only 23 hours long, so two wall clocks are nonexistent
// and shift forward onto real ones — 46 distinct instants, still a clean 30-min
// chain. A fall-back day is 25 hours, but the two repeated wall clocks resolve to
// their first occurrence, so it stays 48 instants with one 90-min gap where the
// duplicated hour was skipped.
//
// HOW MUCH EACH ASSERTION BELOW IS ACTUALLY WORTH, measured by replaying the old
// single-pass probe against every case here — do not delete any of them on the
// assumption that a count is a weak test:
//   - The per-DAY counts DO catch the bug, but only for Australia/Sydney: the old
//     code returned 48 distinct instants on the 2026-10-04 spring day (its 46
//     landed on the Saturday instead, perDay [48,48,48,48,48,46,48]) and zero of
//     the expected 90-min gaps on the 2026-04-05 fall day (span 23.5h, not 24.5h).
//     Three of the assertions below are genuine Sydney regression guards.
//   - For Madrid, London, Berlin and New York the counts prove NOTHING about this
//     bug. The old code produced the IDENTICAL 46 instants (set intersection
//     46/46), the same unbroken 30-min chain and the same 166.5h week span — it
//     merely mapped them to the WRONG wall clocks.
//   - The whole-WEEK union count is non-discriminating in all four zones, Sydney
//     included (334 either way), because a shifted instant collapses onto one the
//     neighbouring day already produced. It is kept as a structural invariant
//     against a future rewrite that loses or duplicates instants.
// The assertion that catches the bug in EVERY zone is the round-trip test at the
// end of this block: 10 of New York's 48 wall clocks failed it, and Sydney's
// 00:00 read back as 23:00 on the PREVIOUS calendar day.

function daySlotInstants(dateKey: string, tz: string): number[] {
  const [y, mo, d] = dateKey.split('-').map(Number)
  return Array.from({ length: 48 }, (_, i) =>
    wallTimeToUtcMs(y, mo, d, Math.floor(i / 2), (i % 2) * 30, tz)
  )
}

const distinctSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b)
const gapsInMinutes = (xs: number[]) => xs.slice(1).map((v, i) => (v - xs[i]) / 60_000)
const weekKeys = (monday: string) => Array.from({ length: 7 }, (_, i) => addDaysToDateKey(monday, i))

describe('distinct half-hour instants per local day', () => {
  it('a plain day is 48 distinct instants in an unbroken 30-min chain', () => {
    for (const tz of ['Europe/Madrid', 'Europe/London', 'America/New_York', 'Australia/Sydney']) {
      const inst = distinctSorted(daySlotInstants('2026-06-15', tz))
      expect(inst, tz).toHaveLength(48)
      expect(new Set(gapsInMinutes(inst)), tz).toEqual(new Set([30]))
      expect(inst[47] - inst[0], tz).toBe(23.5 * 3600_000)
    }
  })

  it('a spring-forward day is 46 distinct instants spanning 23 real hours', () => {
    const cases: [string, string][] = [
      ['Europe/Madrid', '2026-03-29'],
      ['Europe/London', '2026-03-29'],
      ['Europe/Berlin', '2026-03-29'],
      ['America/New_York', '2026-03-08'],
      ['Australia/Sydney', '2026-10-04'],
    ]
    for (const [tz, dateKey] of cases) {
      const inst = distinctSorted(daySlotInstants(dateKey, tz))
      expect(inst, tz).toHaveLength(46)
      expect(new Set(gapsInMinutes(inst)), tz).toEqual(new Set([30]))
      // 45 gaps x 30 min = 22.5h from the first slot start to the last, on a 23h day.
      expect(inst[45] - inst[0], tz).toBe(22.5 * 3600_000)
    }
  })

  it('a fall-back day is 48 distinct instants with exactly one 90-min gap', () => {
    const cases: [string, string][] = [
      ['Europe/Madrid', '2026-10-25'],
      ['Europe/London', '2026-10-25'],
      ['Europe/Berlin', '2026-10-25'],
      ['America/New_York', '2026-11-01'],
      ['Australia/Sydney', '2026-04-05'],
    ]
    for (const [tz, dateKey] of cases) {
      const inst = distinctSorted(daySlotInstants(dateKey, tz))
      expect(inst, tz).toHaveLength(48)
      const gaps = gapsInMinutes(inst)
      expect(gaps.filter((g) => g === 90), tz).toHaveLength(1)
      expect(gaps.filter((g) => g === 30), tz).toHaveLength(46)
      // 46 x 30 + 90 = 1470 min = 24.5h across a 25-hour day.
      expect(inst[47] - inst[0], tz).toBe(24.5 * 3600_000)
    }
  })

  it('every day of a spring-forward week has the right count, and the week chains cleanly', () => {
    const weeks: [string, string][] = [
      ['Europe/Madrid', '2026-03-23'],
      ['Europe/London', '2026-03-23'],
      ['Europe/Berlin', '2026-03-23'],
      ['America/New_York', '2026-03-02'],
      ['Australia/Sydney', '2026-09-28'],
    ]
    for (const [tz, monday] of weeks) {
      const perDay = weekKeys(monday).map((k) => distinctSorted(daySlotInstants(k, tz)).length)
      expect(perDay, tz).toEqual([48, 48, 48, 48, 48, 48, 46])   // Sunday is the transition
      const all = distinctSorted(weekKeys(monday).flatMap((k) => daySlotInstants(k, tz)))
      expect(all, tz).toHaveLength(334)                          // 7 x 48 - 2
      expect(new Set(gapsInMinutes(all)), tz).toEqual(new Set([30]))
      expect(all[333] - all[0], tz).toBe(166.5 * 3600_000)       // a 167-hour week
    }
  })

  it('every day of a fall-back week has the right count, and the week gains exactly one hour', () => {
    const weeks: [string, string][] = [
      ['Europe/Madrid', '2026-10-19'],
      ['Europe/London', '2026-10-19'],
      ['Europe/Berlin', '2026-10-19'],
      ['America/New_York', '2026-10-26'],
      ['Australia/Sydney', '2026-03-30'],
    ]
    for (const [tz, monday] of weeks) {
      const perDay = weekKeys(monday).map((k) => distinctSorted(daySlotInstants(k, tz)).length)
      expect(perDay, tz).toEqual([48, 48, 48, 48, 48, 48, 48])
      const all = distinctSorted(weekKeys(monday).flatMap((k) => daySlotInstants(k, tz)))
      expect(all, tz).toHaveLength(336)                          // 7 x 48
      const gaps = gapsInMinutes(all)
      expect(gaps.filter((g) => g === 90), tz).toHaveLength(1)   // the skipped repeat hour
      expect(gaps.filter((g) => g === 30), tz).toHaveLength(334)
      expect(all[335] - all[0], tz).toBe(168.5 * 3600_000)       // a 169-hour week
    }
  })

  // THE discriminating assertion. Convert a wall clock, read the instant back in
  // the same zone, and you must get that wall clock again. The only exemption is
  // a nonexistent spring-forward slot, which by contract lands on the post-gap
  // clock — same date, same minute, exactly the DST delta later.
  //
  // The single-pass probe failed this on every transition day: Madrid 01:00 read
  // back as 00:00, New York's whole 02:00–06:30 range read back an hour late (10
  // of 48 slots), and Sydney's 00:00 read back as 23:00 on the PREVIOUS DAY.
  it('every existing wall clock round-trips; only spring-forward gap slots shift, and only forward', () => {
    const cases: [string, string, number][] = [
      // tz, local date, how many of the 48 slots are allowed to shift
      ['Europe/Madrid', '2026-03-29', 2], ['Europe/Madrid', '2026-10-25', 0],
      ['Europe/London', '2026-03-29', 2], ['Europe/London', '2026-10-25', 0],
      ['Europe/Berlin', '2026-03-29', 2], ['Europe/Berlin', '2026-10-25', 0],
      ['America/New_York', '2026-03-08', 2], ['America/New_York', '2026-11-01', 0],
      ['Australia/Sydney', '2026-10-04', 2], ['Australia/Sydney', '2026-04-05', 0],
      ['Europe/Madrid', '2026-06-15', 0], ['Australia/Sydney', '2026-06-15', 0],
    ]
    for (const [tz, dateKey, allowedShifts] of cases) {
      const [y, mo, d] = dateKey.split('-').map(Number)
      let shifted = 0
      for (let i = 0; i < 48; i++) {
        const hour = Math.floor(i / 2)
        const minute = (i % 2) * 30
        const label = `${tz} ${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
        const back = utcInstantToTzParts(new Date(wallTimeToUtcMs(y, mo, d, hour, minute, tz)), tz)
        if (back.hour === hour && back.minute === minute) {
          // Round-tripped: it must also still be the requested calendar date.
          expect([back.year, back.month, back.day], label).toEqual([y, mo, d])
          continue
        }
        shifted++
        expect([back.year, back.month, back.day], label).toEqual([y, mo, d])
        expect(back.minute, label).toBe(minute)
        expect(back.hour, label).toBe(hour + 1)   // forward by the 1h DST delta
      }
      expect(shifted, `${tz} ${dateKey}`).toBe(allowedShifts)
    }
  })
})

// ─── localToUtc inherits the shared contract ─────────────────────────────────

describe('localToUtc — DST edges via the shared helper', () => {
  it('matches wallTimeToUtcMs exactly on every transition edge', () => {
    const cases: [string, string][] = [
      ['2026-03-29T02:30', 'Europe/Berlin'],
      ['2026-03-29T03:00', 'Europe/Berlin'],
      ['2026-10-25T02:30', 'Europe/Berlin'],
      ['2026-03-29T01:30', 'Europe/London'],
      ['2026-10-25T01:30', 'Europe/London'],
      ['2026-03-08T02:30', 'America/New_York'],
      ['2026-03-08T03:00', 'America/New_York'],
      ['2026-11-01T01:30', 'America/New_York'],
      ['2026-10-04T02:30', 'Australia/Sydney'],
      ['2026-04-05T02:30', 'Australia/Sydney'],
    ]
    for (const [localIso, tz] of cases) {
      const [y, mo, d, h, mi] = localIso.split(/[-T:]/).map(Number)
      expect(localToUtc(localIso, tz), `${localIso} ${tz}`)
        .toBe(new Date(wallTimeToUtcMs(y, mo, d, h, mi, tz)).toISOString())
    }
  })

  it('New York spring-forward booking time is now written correctly', () => {
    // getWeekWindow, the admin class create/edit routes and EditClassClient all
    // resolve a picked wall clock through here.
    expect(localToUtc('2026-03-08T03:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z')
    expect(localToUtc('2026-03-08T09:00', 'America/New_York')).toBe('2026-03-08T13:00:00.000Z')
  })

  it('week-window midnights across a transition stay 167h / 169h apart', () => {
    // Mirrors getWeekWindow (slotEngine.ts:48) without importing it.
    const span = (monday: string, tz: string) =>
      new Date(localToUtc(addDaysToDateKey(monday, 7) + 'T00:00', tz)).getTime() -
      new Date(localToUtc(monday + 'T00:00', tz)).getTime()
    expect(span('2026-03-02', 'America/New_York')).toBe(167 * 3600_000)
    expect(span('2026-10-26', 'America/New_York')).toBe(169 * 3600_000)
    expect(span('2026-03-23', 'Europe/London')).toBe(167 * 3600_000)
    expect(span('2026-10-19', 'Europe/London')).toBe(169 * 3600_000)
    expect(span('2026-09-28', 'Australia/Sydney')).toBe(167 * 3600_000)
    expect(span('2026-03-30', 'Australia/Sydney')).toBe(169 * 3600_000)
  })
})
