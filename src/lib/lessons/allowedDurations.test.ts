import { describe, it, expect } from 'vitest'
import { checkAllowedDuration } from './allowedDurations'

describe('checkAllowedDuration - parsed values', () => {
  it("returns 'ok' when the duration is in the list", () => {
    expect(checkAllowedDuration([30, 60, 90], 60).state).toBe('ok')
  })

  it("returns 'ok' for a single-entry list that matches", () => {
    // The column default is '{60}', so this is the commonest row in the table.
    expect(checkAllowedDuration([60], 60).state).toBe('ok')
  })

  it("returns 'not_allowed' when the duration is absent from the list", () => {
    expect(checkAllowedDuration([30, 90], 60).state).toBe('not_allowed')
  })

  it('carries the parsed list back on both parsed states', () => {
    // The caller needs it verbatim for the "(30, 90)" half of the marker copy, so
    // the order and contents must survive the check unaltered.
    expect(checkAllowedDuration([30, 90], 60)).toEqual({
      state: 'not_allowed',
      durations: [30, 90],
    })
    expect(checkAllowedDuration([90, 30], 30)).toEqual({
      state: 'ok',
      durations: [90, 30],
    })
  })
})

describe("checkAllowedDuration - 'unknown' (the value could not be read)", () => {
  // Every case here MUST be 'unknown' and never 'ok'. Collapsing any of them into
  // 'ok' turns the marker silently off, which reads on screen as "this duration is
  // fine" - the exact failure the three-state shape exists to prevent.

  it('null is unknown', () => {
    expect(checkAllowedDuration(null, 60)).toEqual({ state: 'unknown', durations: null })
  })

  it('undefined is unknown (the column was left out of a select)', () => {
    expect(checkAllowedDuration(undefined, 60)).toEqual({ state: 'unknown', durations: null })
  })

  it('an empty array is unknown, not "nothing is allowed"', () => {
    // The DB CHECK forbids an empty array, so one arriving here means the value did
    // not come from the column intact.
    expect(checkAllowedDuration([], 60)).toEqual({ state: 'unknown', durations: null })
  })

  it('a non-array value is unknown', () => {
    expect(checkAllowedDuration(60, 60).state).toBe('unknown')
    expect(checkAllowedDuration('60', 60).state).toBe('unknown')
    expect(checkAllowedDuration({ 0: 60 }, 60).state).toBe('unknown')
    expect(checkAllowedDuration(true, 60).state).toBe('unknown')
  })

  it('an array containing a string is unknown, even when a numeric entry matches', () => {
    // The matching 60 must NOT rescue the row: a value that arrived half-parsed is
    // not a list we can report on.
    expect(checkAllowedDuration([60, '90'], 60)).toEqual({ state: 'unknown', durations: null })
    expect(checkAllowedDuration(['60'], 60)).toEqual({ state: 'unknown', durations: null })
  })

  it('an array containing null, a boolean or a nested array is unknown', () => {
    expect(checkAllowedDuration([30, null], 30).state).toBe('unknown')
    expect(checkAllowedDuration([30, true], 30).state).toBe('unknown')
    expect(checkAllowedDuration([[30]], 30).state).toBe('unknown')
  })

  it('NaN and Infinity are unknown, not numeric entries', () => {
    // typeof passes for both; neither can name a class length.
    expect(checkAllowedDuration([NaN], 60).state).toBe('unknown')
    expect(checkAllowedDuration([60, Infinity], 60).state).toBe('unknown')
  })
})

describe('checkAllowedDuration - durations outside {30,60,90}', () => {
  // The helper is a plain membership test and deliberately does NOT filter to the
  // three lengths the booking flow offers. Legacy or admin-created rows can hold
  // any duration, and a marker that quietly reclassified them would misreport.

  it("reports a 45-minute lesson against a standard list as 'not_allowed'", () => {
    expect(checkAllowedDuration([30, 60, 90], 45).state).toBe('not_allowed')
  })

  it("reports a 45-minute lesson against a 45-minute allowance as 'ok'", () => {
    expect(checkAllowedDuration([45], 45)).toEqual({ state: 'ok', durations: [45] })
  })

  it('does not treat a 0 or negative duration as a match', () => {
    expect(checkAllowedDuration([30, 60, 90], 0).state).toBe('not_allowed')
    expect(checkAllowedDuration([30, 60, 90], -60).state).toBe('not_allowed')
  })

  it('keeps a non-standard entry in the returned list', () => {
    expect(checkAllowedDuration([45, 60], 60)).toEqual({ state: 'ok', durations: [45, 60] })
  })
})
