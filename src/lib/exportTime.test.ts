import { describe, it, expect } from 'vitest'
import {
  formatInstantInTz,
  formatDateInTz,
  formatLongDateInTz,
  formatTimeInTz,
  formatTimeRangeInTz,
  formatLongInstantInTz,
  zonedCalendarDateForExcel,
  ymdForExcel,
  formatLongDateOnly,
} from './exportTime'

/**
 * Export date/time rendering.
 *
 * Every tabular export renders its Lesson Date as a REAL Excel date cell and its
 * Lesson Time as a 'HH:MM - HH:MM' start/end range. Two classes of bug are what
 * this suite exists to catch:
 *
 *  1. DAY DRIFT. `scheduled_at` is a timestamptz. The calendar day it falls on
 *     depends on the export timezone, so 20 Aug 23:30 UTC is 21 August in SAST.
 *     A date cell built from the wrong components (or from the HOST's timezone)
 *     exports the previous day, silently, on Vercel but not on a dev laptop.
 *
 *  2. EXCEL SERIAL SHIFT. ExcelJS's dateToExcel reads d.getTime() — the absolute
 *     instant — so only a Date anchored at midnight UTC serialises to a whole
 *     number. new Date(y, m-1, d) instead offsets the serial by the host's UTC
 *     offset, which on a UTC+2 box turns 21 Aug into "20 Aug 22:00".
 *
 * 2026 transitions used here:
 *   Africa/Johannesburg  never transitions (UTC+2 year round)
 *   Europe/Madrid        spring Sun 29 Mar 01:00Z, CET (+1) -> CEST (+2)
 */

const SAST = 'Africa/Johannesburg'
const MADRID = 'Europe/Madrid'

// ── The two FROZEN screen formatters ────────────────────────────────────────
// BillingClient, ClassesListClient, BillingAdminClient and reports/[id] all
// render through these. The export work must not have moved them.
describe('frozen screen formatters', () => {
  it('formatInstantInTz still renders DD/MM/YYYY HH:MM', () => {
    expect(formatInstantInTz('2026-08-21T11:30:00Z', SAST)).toBe('21/08/2026 13:30')
  })

  it('formatDateInTz still renders DD/MM/YYYY', () => {
    expect(formatDateInTz('2026-08-21T11:30:00Z', SAST)).toBe('21/08/2026')
  })

  it('formatInstantInTz still guards the Intl "24" hour quirk at midnight', () => {
    expect(formatInstantInTz('2026-08-20T22:00:00Z', SAST)).toBe('21/08/2026 00:00')
  })
})

// ── formatLongDateInTz ──────────────────────────────────────────────────────
describe('formatLongDateInTz', () => {
  it('renders the long date in SAST', () => {
    expect(formatLongDateInTz('2026-08-21T11:30:00Z', SAST)).toBe('21 August 2026')
  })

  it('rolls to the NEXT day for a late-evening UTC instant in SAST', () => {
    // 23:30Z on 20 Aug is 01:30 on 21 Aug in SAST.
    expect(formatLongDateInTz('2026-08-20T23:30:00Z', SAST)).toBe('21 August 2026')
  })

  it('rolls to the next day in Europe/Madrid summer time (CEST, +2)', () => {
    expect(formatLongDateInTz('2026-08-21T23:30:00Z', MADRID)).toBe('22 August 2026')
  })

  it('rolls to the next day in Europe/Madrid winter time (CET, +1)', () => {
    // 23:30Z in January is 00:30 the next day at +1, not +2.
    expect(formatLongDateInTz('2026-01-15T23:30:00Z', MADRID)).toBe('16 January 2026')
  })

  it('accepts a Date as well as an ISO string', () => {
    expect(formatLongDateInTz(new Date('2026-08-21T11:30:00Z'), SAST)).toBe('21 August 2026')
  })

  it('returns empty string for an unparseable value rather than throwing', () => {
    expect(formatLongDateInTz('not-a-date', SAST)).toBe('')
  })
})

// ── formatTimeInTz ──────────────────────────────────────────────────────────
describe('formatTimeInTz', () => {
  it('renders 24-hour wall clock in SAST', () => {
    expect(formatTimeInTz('2026-08-21T11:30:00Z', SAST)).toBe('13:30')
  })

  it('renders midnight as 00:00, not 24:00', () => {
    // 22:00Z is exactly local midnight in SAST — the Intl "24" quirk case.
    expect(formatTimeInTz('2026-08-20T22:00:00Z', SAST)).toBe('00:00')
  })

  it('renders midnight as 00:00 in Europe/Madrid too', () => {
    expect(formatTimeInTz('2026-08-21T22:00:00Z', MADRID)).toBe('00:00')
  })

  it('returns empty string for an unparseable value', () => {
    expect(formatTimeInTz('not-a-date', SAST)).toBe('')
  })
})

// ── formatTimeRangeInTz ─────────────────────────────────────────────────────
describe('formatTimeRangeInTz', () => {
  it('renders start and end separated by an ASCII hyphen with spaces', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', 60, SAST)).toBe('13:30 - 14:30')
  })

  it('handles a non-hour duration', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', 90, SAST)).toBe('13:30 - 15:00')
  })

  it('crosses local midnight correctly', () => {
    // 21:30Z is 23:30 SAST; +60 min ends 00:30 the NEXT local day.
    expect(formatTimeRangeInTz('2026-08-21T21:30:00Z', 60, SAST)).toBe('23:30 - 00:30')
  })

  it('crosses a DST spring-forward correctly in Europe/Madrid', () => {
    // 00:30Z on 29 Mar is 01:30 CET; +60 min of REAL time lands at 01:30Z,
    // which is 03:30 CEST. The wall clock appears to jump because 02:00-03:00
    // does not exist that day — the class is still 60 minutes long.
    expect(formatTimeRangeInTz('2026-03-29T00:30:00Z', 60, MADRID)).toBe('01:30 - 03:30')
  })

  it('falls back to the start time alone when duration is null', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', null, SAST)).toBe('13:30')
  })

  it('falls back to the start time alone when duration is undefined', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', undefined, SAST)).toBe('13:30')
  })

  it('falls back to the start time alone for a zero or negative duration', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', 0, SAST)).toBe('13:30')
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', -30, SAST)).toBe('13:30')
  })

  it('falls back to the start time alone for a non-finite duration', () => {
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', NaN, SAST)).toBe('13:30')
    expect(formatTimeRangeInTz('2026-08-21T11:30:00Z', Infinity, SAST)).toBe('13:30')
  })

  it('returns empty string when the start itself is unparseable', () => {
    expect(formatTimeRangeInTz('not-a-date', 60, SAST)).toBe('')
  })
})

// ── formatLongInstantInTz ───────────────────────────────────────────────────
describe('formatLongInstantInTz', () => {
  it('renders "21 August 2026, 14:05"', () => {
    expect(formatLongInstantInTz('2026-08-21T12:05:00Z', SAST)).toBe('21 August 2026, 14:05')
  })

  it('rolls the date as well as the time across the day boundary', () => {
    expect(formatLongInstantInTz('2026-08-20T23:30:00Z', SAST)).toBe('21 August 2026, 01:30')
  })

  it('renders in Europe/Madrid', () => {
    expect(formatLongInstantInTz('2026-08-21T12:05:00Z', MADRID)).toBe('21 August 2026, 14:05')
  })

  it('returns empty string for an unparseable value', () => {
    expect(formatLongInstantInTz('not-a-date', SAST)).toBe('')
  })
})

// ── zonedCalendarDateForExcel ───────────────────────────────────────────────
describe('zonedCalendarDateForExcel', () => {
  it('yields 21 Aug for 23:30 UTC on 20 Aug in Africa/Johannesburg', () => {
    const d = zonedCalendarDateForExcel('2026-08-20T23:30:00Z', SAST)
    expect(d?.toISOString()).toBe('2026-08-21T00:00:00.000Z')
  })

  it('yields 22 Aug for 23:30 UTC on 21 Aug in Europe/Madrid', () => {
    const d = zonedCalendarDateForExcel('2026-08-21T23:30:00Z', MADRID)
    expect(d?.toISOString()).toBe('2026-08-22T00:00:00.000Z')
  })

  it('keeps the same day for a mid-afternoon instant', () => {
    const d = zonedCalendarDateForExcel('2026-08-21T11:30:00Z', SAST)
    expect(d?.toISOString()).toBe('2026-08-21T00:00:00.000Z')
  })

  it('handles an instant that is exactly local midnight', () => {
    // 22:00Z == 00:00 SAST on 21 Aug. The day must be 21 Aug, not 20 Aug.
    const d = zonedCalendarDateForExcel('2026-08-20T22:00:00Z', SAST)
    expect(d?.toISOString()).toBe('2026-08-21T00:00:00.000Z')
  })

  it('anchors at midnight UTC so ExcelJS writes a WHOLE-number date serial', () => {
    // Mirrors exceljs lib/utils/utils.js:55 dateToExcel(d, date1904):
    //   25569 + d.getTime() / (24 * 3600 * 1000)   [date1904 is undefined here]
    // A fractional serial means Excel shows a time-of-day and sorts oddly.
    const d = zonedCalendarDateForExcel('2026-08-20T23:30:00Z', SAST)!
    const serial = 25569 + d.getTime() / (24 * 3600 * 1000)
    expect(serial).toBe(46255)
    expect(Number.isInteger(serial)).toBe(true)
  })

  it('returns null rather than an Invalid Date for an unparseable value', () => {
    // An Invalid Date would make dateToExcel emit <v>NaN</v> and Excel would
    // refuse to open the workbook; null renders as an empty cell instead.
    expect(zonedCalendarDateForExcel('not-a-date', SAST)).toBeNull()
  })

  it('returns null for an unknown IANA zone rather than throwing', () => {
    expect(zonedCalendarDateForExcel('2026-08-21T11:30:00Z', 'Mars/Olympus_Mons')).toBeNull()
  })
})

// ── ymdForExcel ─────────────────────────────────────────────────────────────
describe('ymdForExcel', () => {
  it('converts a bare YYYY-MM-DD to midnight UTC of that day', () => {
    expect(ymdForExcel('2026-08-01')?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('applies NO timezone conversion — a date column has no instant', () => {
    // Both ends of the year, to prove no offset is ever added or subtracted.
    expect(ymdForExcel('2026-01-01')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(ymdForExcel('2026-12-31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z')
  })

  it('yields a whole-number Excel serial', () => {
    const d = ymdForExcel('2026-08-01')!
    expect(Number.isInteger(25569 + d.getTime() / (24 * 3600 * 1000))).toBe(true)
  })

  it('tolerates a trailing time component', () => {
    expect(ymdForExcel('2026-08-01T00:00:00+00:00')?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('returns null for a date that does not exist', () => {
    expect(ymdForExcel('2026-02-31')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(ymdForExcel('2026-8-1')).toBeNull()
    expect(ymdForExcel('01/08/2026')).toBeNull()
    expect(ymdForExcel('garbage')).toBeNull()
    expect(ymdForExcel('20260801')).toBeNull()
  })

  it('returns null for empty, null and undefined', () => {
    expect(ymdForExcel('')).toBeNull()
    expect(ymdForExcel(null)).toBeNull()
    expect(ymdForExcel(undefined)).toBeNull()
  })
})

// ── formatLongDateOnly ──────────────────────────────────────────────────────
describe('formatLongDateOnly', () => {
  it('renders a bare YYYY-MM-DD as a long date', () => {
    expect(formatLongDateOnly('2026-08-01')).toBe('1 August 2026')
  })

  it('does not pad the day', () => {
    expect(formatLongDateOnly('2026-08-09')).toBe('9 August 2026')
  })

  it('renders the last day of the year without drifting', () => {
    expect(formatLongDateOnly('2026-12-31')).toBe('31 December 2026')
  })

  it('renders the first day of the year without drifting', () => {
    expect(formatLongDateOnly('2026-01-01')).toBe('1 January 2026')
  })

  it('returns empty string for a date that does not exist', () => {
    expect(formatLongDateOnly('2026-02-31')).toBe('')
  })

  it('returns empty string for malformed, empty, null and undefined', () => {
    expect(formatLongDateOnly('garbage')).toBe('')
    expect(formatLongDateOnly('')).toBe('')
    expect(formatLongDateOnly(null)).toBe('')
    expect(formatLongDateOnly(undefined)).toBe('')
  })
})
