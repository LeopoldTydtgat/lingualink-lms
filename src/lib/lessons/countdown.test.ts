import { describe, it, expect } from 'vitest'
import { describeLessonCountdown, formatHeroCountdown } from './countdown'

// A single 10:00-11:00 class, probed at fixed instants. Everything here is epoch ms:
// describeLessonCountdown never constructs a Date from local parts and never reads a
// timezone, so these tests do not need one either.
const START = new Date('2026-07-01T10:00:00.000Z').getTime()
const END = START + 60 * 60_000
const MIN = 60_000

describe('describeLessonCountdown - before the class', () => {
  it('counts down to the start well before it', () => {
    const res = describeLessonCountdown(START, END, START - 90 * MIN)
    expect(res.live).toBe(false)
    expect(res.label).toBe('Starts in')
    expect(res.value).toBe('1h 30m 00s')
  })

  it('is NOT live one ms before the start instant', () => {
    // Sub-second truncation: 1ms of lead time floors to 0 seconds, which the pre-class
    // formatter renders as "Starting now". Still not live - the pill must not flip yet.
    const res = describeLessonCountdown(START, END, START - 1)
    expect(res.live).toBe(false)
    expect(res.label).toBe('Starts in')
    expect(res.value).toBe('Starting now')
  })
})

describe('describeLessonCountdown - during the class (the bug this fixes)', () => {
  it('is LIVE at the exact start instant (now === start)', () => {
    // The teaching window is half-open [start, end): the start instant itself counts,
    // matching pickLiveLesson. Getting this edge wrong is exactly what left a class that
    // had just begun reading "Starting now" under a NEXT pill.
    const res = describeLessonCountdown(START, END, START)
    expect(res.live).toBe(true)
    expect(res.label).toBe('In class')
    expect(res.value).toBe('1:00:00')
  })

  it('counts DOWN to the end mid-class, never up from the start', () => {
    const res = describeLessonCountdown(START, END, START + 12 * MIN + 23_000)
    expect(res.live).toBe(true)
    expect(res.label).toBe('In class')
    expect(res.value).toBe('47:37')
  })

  it('is LIVE one second before the end', () => {
    const res = describeLessonCountdown(START, END, END - 1000)
    expect(res.live).toBe(true)
    expect(res.label).toBe('In class')
    expect(res.value).toBe('00:01')
  })

  it('never reads "Starting now" at any minute inside the class', () => {
    for (let m = 0; m < 60; m++) {
      const res = describeLessonCountdown(START, END, START + m * MIN)
      expect(res.live).toBe(true)
      expect(res.value).not.toBe('Starting now')
    }
  })
})

describe('describeLessonCountdown - after the class', () => {
  it('is NOT live at the exact end instant (now === end)', () => {
    // Half-open [start, end): the end instant belongs to the not-live side.
    const res = describeLessonCountdown(START, END, END)
    expect(res.live).toBe(false)
    expect(res.label).toBe('Starts in')
    expect(res.value).toBe('Starting now')
  })

  it('is NOT live once the class is over, and does not count up', () => {
    const res = describeLessonCountdown(START, END, END + 5 * MIN)
    expect(res.live).toBe(false)
    expect(res.label).toBe('Starts in')
    expect(res.value).toBe('Starting now')
  })
})

describe('describeLessonCountdown - format shape', () => {
  // A 90-minute class, so the remaining timer crosses the one-hour boundary mid-class.
  const END_90 = START + 90 * MIN

  it('uses the hours branch for a 90-minute class', () => {
    const res = describeLessonCountdown(START, END_90, START + 10 * MIN)
    expect(res.live).toBe(true)
    expect(res.value).toBe('1:20:00')
  })

  it('emits MM:SS with no hour block under an hour remaining', () => {
    const res = describeLessonCountdown(START, END_90, START + 31 * MIN)
    expect(res.value).toMatch(/^\d{2}:\d{2}$/)
    expect(res.value).toBe('59:00')
  })

  it('emits H:MM:SS with an UNPADDED hour at an hour or more remaining', () => {
    const res = describeLessonCountdown(START, END_90, START + 29 * MIN)
    expect(res.value).toMatch(/^\d:\d{2}:\d{2}$/)
    expect(res.value).toBe('1:01:00')
  })
})

describe('describeLessonCountdown - msUntilStart', () => {
  it('is the exact millisecond lead time before the class', () => {
    const res = describeLessonCountdown(START, END, START - 90 * MIN)
    expect(res.msUntilStart).toBe(90 * MIN)
  })

  it('is zero at the exact start instant', () => {
    const res = describeLessonCountdown(START, END, START)
    expect(res.msUntilStart).toBe(0)
  })

  it('goes negative once the class is underway rather than clamping', () => {
    const res = describeLessonCountdown(START, END, START + 12 * MIN)
    expect(res.msUntilStart).toBe(-12 * MIN)
  })

  it('stays negative after the end, where value collapses to "Starting now"', () => {
    const res = describeLessonCountdown(START, END, END + 5 * MIN)
    expect(res.msUntilStart).toBe(-65 * MIN)
    expect(res.value).toBe('Starting now')
  })

  it('keeps the sub-second precision that value floors away', () => {
    const res = describeLessonCountdown(START, END, START - 1)
    expect(res.msUntilStart).toBe(1)
    expect(res.value).toBe('Starting now')
  })

  it('lands on the correct side of the 24h reschedule gate', () => {
    // The teacher Cancel Class button gates on > 24h, so exactly 24h must NOT qualify.
    const DAY = 24 * 60 * MIN
    expect(describeLessonCountdown(START, END, START - DAY).msUntilStart).toBe(DAY)
    expect(describeLessonCountdown(START, END, START - DAY - 1).msUntilStart).toBeGreaterThan(DAY)
  })
})

describe('formatHeroCountdown', () => {
  it('floors at "Now" on zero', () => {
    expect(formatHeroCountdown(0)).toBe('Now')
  })

  it('floors at "Now" on a negative value rather than counting up', () => {
    expect(formatHeroCountdown(-90)).toBe('Now')
  })

  it('uses the compound d/h/m form at a day or more out, with no seconds', () => {
    // 3d 5h 30m 45s -> seconds are dropped above a day
    const secs = 3 * 86400 + 5 * 3600 + 30 * 60 + 45
    expect(formatHeroCountdown(secs)).toBe('3d 5h 30m')
  })

  it('zero-pads the minutes in the days branch', () => {
    const secs = 1 * 86400 + 2 * 3600 + 5 * 60
    expect(formatHeroCountdown(secs)).toBe('1d 2h 05m')
  })

  it('emits a zero-padded HH:MM:SS block under a day', () => {
    expect(formatHeroCountdown(10 * 3600 + 18 * 60 + 36)).toBe('10:18:36')
  })

  it('keeps the padded 00 hour block under an hour - unlike formatRemainingCountdown', () => {
    expect(formatHeroCountdown(47 * 60 + 37)).toBe('00:47:37')
  })

  it('pads single-digit hours, minutes and seconds', () => {
    expect(formatHeroCountdown(1 * 3600 + 2 * 60 + 3)).toBe('01:02:03')
  })

  it('emits 00:00:01 one second out', () => {
    expect(formatHeroCountdown(1)).toBe('00:00:01')
  })
})
