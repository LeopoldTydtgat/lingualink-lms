import { getDayKeyInTz } from '@/lib/billing/monthRange'
import { addDaysToDateKey, utcInstantToTzParts } from '@/lib/utils/timezone'

/**
 * Timezone-correct calendar presets for the admin date-range filter.
 *
 * Every value this module produces is a 'YYYY-MM-DD' day key in `tz` — the same
 * currency the admin Classes GET filter already speaks (date_from / date_to) and the
 * same one /admin/classes?filter=today seeds through getDayKeyInTz. A preset and the
 * deep link therefore agree on which day is which by construction, not by coincidence.
 *
 * THREE PRIMITIVES, NO NEW DATE MATH. This file deliberately owns no calendar
 * arithmetic of its own; it composes the three the project already has under test:
 *
 *   getDayKeyInTz(now, tz)               — which calendar day "now" falls on in tz
 *                                          (Intl parts in tz; billing/monthRange.ts)
 *   utcInstantToTzParts(now, tz).weekday — which weekday that day is, 0=Sun..6=Sat,
 *                                          from a locale-pinned en-GB Intl probe in
 *                                          tz (utils/timezone.ts)
 *   addDaysToDateKey(key, n)             — that day key n calendar days later
 *                                          (Date.UTC in, getUTC* out; utils/timezone.ts)
 *
 * The two zone-aware reads probe the SAME instant in the SAME zone through Intl, so
 * the day key and the weekday can never describe different days. Their locales differ
 * (en-CA vs en-GB), which decides the spelling of a field and never which calendar day
 * an instant falls on.
 *
 * HARD RULES honoured throughout:
 *   - no ISO-string round trip anywhere in date construction: an ISO UTC string names
 *     the UTC day, a different day for any zone whose offset pushes the instant across
 *     midnight
 *   - no browser-local calendar getters — the local weekday / month / year accessors
 *     read the machine's zone, never the admin's
 *   - day keys are assembled from calendar parts as template strings, nothing else
 *
 * ---------------------------------------------------------------------------------
 * DST WALKTHROUGH — Europe/Madrid, the October fall-back, 'this_week'
 * ---------------------------------------------------------------------------------
 * Madrid leaves DST at 03:00 local on Sunday 25 October 2026 (+02:00 -> +01:00), so
 * that Sunday is a 25-hour day. Take now = Friday 23 October 2026, 21:00 Madrid:
 *
 *   getDayKeyInTz(now, 'Europe/Madrid')               -> '2026-10-23'
 *   utcInstantToTzParts(now, 'Europe/Madrid').weekday -> 5 (Fri)
 *   daysSinceMonday = (5 + 6) % 7                     =  4
 *   monday = addDaysToDateKey('2026-10-23', -4)       -> '2026-10-19'
 *   sunday = addDaysToDateKey('2026-10-19',  6)       -> '2026-10-25'
 *
 * Mon 19 Oct -> Sun 25 Oct: the week a Madrid admin is actually living in, with the
 * 25-hour Sunday as its last day. The transition cannot perturb a single step, because
 * addDaysToDateKey splits the key into calendar numbers, hands them to Date.UTC and
 * reads them back with getUTC* — no timezone at all, neither Madrid nor the browser's,
 * is consulted between the two endpoints. Only the first read ("which day is it in
 * Madrid?") is zone-aware, and that is one instantaneous probe rather than a span.
 *
 * The bug this shape forecloses: stepping days by adding 86_400_000 ms to a real
 * instant and re-reading the calendar in tz. Across that 25-hour Sunday one such step
 * lands an hour short of the next local midnight and the readback repeats 24 October,
 * so the week comes back a day narrow. Nothing here ever adds milliseconds.
 */
export type DateRangePreset = 'today' | 'this_week' | 'this_month' | 'last_month'

/** Inclusive 'YYYY-MM-DD' day keys, both ends resolved in the caller's timezone. */
export interface DateRange {
  from: string
  to: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Calendar numbers behind a 'YYYY-MM-DD' key. Pure string work — no Date involved. */
function partsOfDayKey(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number)
  return { year, month }
}

/** First day key of a calendar month. */
function firstDayKeyOfMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`
}

/**
 * Last day key of a calendar month: the day before the first of the next one, with
 * the December -> January rollover handled on the calendar numbers. Derived rather
 * than table-driven so month lengths and leap years stay the business of one
 * already-tested primitive instead of a second copy of the rules.
 */
function lastDayKeyOfMonth(year: number, month: number): string {
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return addDaysToDateKey(firstDayKeyOfMonth(nextYear, nextMonth), -1)
}

/**
 * The inclusive day-key range `preset` covers, as seen from `tz` at instant `now`.
 *
 * `tz` must be a valid IANA identifier. Callers hold a profiles.timezone that may be
 * unset and must suppress presets entirely in that case (see DateRangeFilter) — there
 * is no honest answer to "which day is today" without a zone, and defaulting to UTC
 * would name the wrong day for most of the world. That is the same call the server
 * page makes when it declines to seed ?filter=today.
 */
export function getPresetRange(preset: DateRangePreset, now: Date, tz: string): DateRange {
  const todayKey = getDayKeyInTz(now, tz)
  const { year, month } = partsOfDayKey(todayKey)

  switch (preset) {
    case 'today':
      return { from: todayKey, to: todayKey }

    case 'this_week': {
      // Monday-first, matching every other week in this app (utils/week.ts, and
      // BookingGridClient's getWeekStartKey). A Sunday maps BACK to the Monday six
      // days earlier, never forward into the week that has not started yet.
      const weekday = utcInstantToTzParts(now, tz).weekday // 0=Sun .. 6=Sat
      const daysSinceMonday = (weekday + 6) % 7
      const monday = addDaysToDateKey(todayKey, -daysSinceMonday)
      return { from: monday, to: addDaysToDateKey(monday, 6) }
    }

    case 'this_month':
      return {
        from: firstDayKeyOfMonth(year, month),
        to: lastDayKeyOfMonth(year, month),
      }

    case 'last_month': {
      const prevYear = month === 1 ? year - 1 : year
      const prevMonth = month === 1 ? 12 : month - 1
      return {
        from: firstDayKeyOfMonth(prevYear, prevMonth),
        to: lastDayKeyOfMonth(prevYear, prevMonth),
      }
    }
  }
}

/**
 * Month-to-date: first day of the current calendar month through today, both
 * resolved in `tz`. NOT a preset: it is the admin surfaces' landing default,
 * re-computed on every landing rather than stored, so it can never go stale
 * across a month boundary. Deliberately absent from PRESETS in
 * DateRangeFilter — no button offers it, and on landing no quick-range
 * highlight is expected (except the 1st of the month, when it equals the
 * Today preset by arithmetic).
 * Same contract as getPresetRange: `tz` must be a valid IANA zone; callers
 * holding a null/empty timezone must not call this and must seed nothing.
 */
export function getMonthToDateRange(now: Date, tz: string): DateRange {
  const todayKey = getDayKeyInTz(now, tz)
  const { year, month } = partsOfDayKey(todayKey)
  return { from: firstDayKeyOfMonth(year, month), to: todayKey }
}
