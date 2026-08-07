import { describe, it, expect } from 'vitest'
import { describeLessonCountdown } from './countdown'

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
