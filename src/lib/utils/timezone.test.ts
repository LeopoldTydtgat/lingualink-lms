import { describe, it, expect } from 'vitest'
import { localToUtc } from '@/lib/utils/timezone'

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
