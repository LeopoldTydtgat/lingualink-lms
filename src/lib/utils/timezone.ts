const DAY_MS = 86_400_000

// One Intl.DateTimeFormat per timezone. Constructing a formatter is the expensive
// part of an offset probe and the DST-correct algorithm below needs two or three
// probes per conversion, where the old single-pass code needed one; the slot engine
// runs it hundreds of times per request. An invalid tz throws out of the
// constructor BEFORE the .set(), so it can never be cached.
//
// The key is lower-cased and the map is bounded, because tz reaches here from a
// user-supplied ?timezone= (src/app/api/student/availability/route.ts:46) that is
// validated only by "Intl accepts it". Intl matches IANA names case-insensitively,
// so 'Europe/Madrid' and 'europe/MADRID' are both valid and would otherwise be
// separate entries — 2^12 keys for one zone, unbounded retention on a warm lambda.
// No two real IANA zones differ only by case, so lower-casing cannot collide.
const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>()
const MAX_CACHED_FORMATTERS = 64

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  const key = tz.toLowerCase()
  const cached = OFFSET_FORMATTERS.get(key)
  if (cached) return cached
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  // Far above the handful of zones any real request touches; a flush costs one
  // rebuild per zone, never a wrong answer.
  if (OFFSET_FORMATTERS.size >= MAX_CACHED_FORMATTERS) OFFSET_FORMATTERS.clear()
  OFFSET_FORMATTERS.set(key, fmt)
  return fmt
}

/**
 * Offset of `tz` from UTC, in milliseconds, AT the given UTC instant.
 * Positive east of Greenwich (Europe/Madrid in summer = +7_200_000).
 *
 * The instant is floored to the whole minute before probing because the readback
 * is minute-resolution. Every IANA offset from 1972-01-08 onward is a whole
 * number of minutes and every transition lands on a minute boundary, so flooring
 * cannot move the probe into a different offset period.
 *
 * The cutoff is exact, not hand-waving: Africa/Monrovia ran -00:44:30 until
 * 1972-01-07 and was the last zone with a sub-minute offset (verified against
 * this runtime's tzdata across all IANA zones). Pre-1972 wall times therefore
 * resolve up to 59s late, and pre-1970 LMT offsets more often. Unreachable in
 * this app — every write path rejects the past and every read path derives its
 * dates from new Date() or a stored billing month — so this is a documented
 * limit, not a live defect. Do not reuse this helper for historical data.
 *
 * Throws RangeError on an invalid `tz` (Intl's own behaviour).
 */
function tzOffsetMsAt(instantMs: number, tz: string): number {
  const flooredMs = Math.floor(instantMs / 60_000) * 60_000
  const parts = offsetFormatter(tz).formatToParts(new Date(flooredMs))
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10)
  // Some ICU builds emit hour "24" for midnight under hour12: false (hourCycle
  // h24) while keeping that day's own date — normalise to 0, as utcInstantToTzParts does.
  const rawHour = get('hour')
  const wallMs = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    rawHour === 24 ? 0 : rawHour, get('minute'), 0
  )
  return wallMs - flooredMs
}

/**
 * Wall-clock parts in a named IANA timezone → the UTC instant (ms since epoch)
 * they denote. The DST-correct local→UTC primitive for the booking, availability
 * and billing paths: localToUtc below, localTimeToUtcMs (src/lib/availability.ts)
 * and localMidnightToUtc (src/lib/billing/monthRange.ts) are all thin wrappers.
 *
 * NOT the only one in the repo: src/lib/exportTime.ts:170 zonedMidnightUtcMs is a
 * separate local-midnight→UTC implementation using the weaker "re-probe once at
 * the candidate" form, whose ambiguity behaviour is hemisphere-dependent and
 * which returns a PRE-gap instant on the previous local day for midnight-gap
 * zones. It is currently safe only because EXPORT_TZ_ALLOWED
 * (src/lib/exportTime.ts:33) restricts it to six zones where the two agree.
 * Fold it into this helper before that allow-list is widened.
 *
 * WHY NOT ONE PASS. The naive probe reads the offset at Date.UTC(wall parts) —
 * the wall clock reinterpreted as if it were UTC — and subtracts it. That probe
 * instant sits up to 14 hours away from the answer, so a DST transition falling
 * in between makes it read the WRONG side's offset and the result lands an hour
 * off. Real failure this replaces: America/New_York wall 03:00 on 2026-03-08
 * (spring-forward day) probed at 03:00Z, which is still 22:00 EST on Mar 7,
 * yielding -5h and 08:00Z instead of the correct 07:00Z.
 *
 * ALGORITHM. Probe the offset a full day either side of the wall instant; the
 * two probes bracket any single transition (transitions are months apart, so a
 * ±24h window can only contain the one that matters). Each offset yields a
 * candidate instant, and a candidate is VALID when the offset actually in force
 * AT it equals the offset used to build it:
 *   - offsets equal     → no transition nearby; one candidate, return it (2 probes)
 *   - exactly one valid → the ordinary near-transition case
 *   - both valid        → AMBIGUOUS wall time (the fall-back hour, which occurs
 *                         twice). Returns the EARLIER instant — the first
 *                         occurrence, still on the pre-transition offset.
 *   - neither valid     → NONEXISTENT wall time (inside the spring-forward gap,
 *                         e.g. 02:30 in New York on 2026-03-08). Returns the wall
 *                         time shifted FORWARD by the gap, so 02:30 resolves to
 *                         03:30 EDT. Never throws; never returns a pre-gap instant.
 * candidateBefore is built from the pre-transition offset, so it is the earlier
 * of the two on a fall-back and the forward-shifted one on a spring-forward —
 * both edge rules are hemisphere-independent and match Temporal's 'compatible'
 * disambiguation. Pinned by tests in timezone.test.ts.
 *
 * @param year full year
 * @param month 1-12
 * @param day 1-31
 * @param hour 0-23
 * @param minute 0-59
 * @param tz IANA timezone identifier
 * @returns UTC instant in milliseconds since the epoch
 * @throws RangeError on an invalid `tz` (Intl's own behaviour) — write-side
 *         callers must fail closed rather than swallow it.
 */
export function wallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): number {
  const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offsetBefore = tzOffsetMsAt(wallAsUtcMs - DAY_MS, tz)
  const offsetAfter = tzOffsetMsAt(wallAsUtcMs + DAY_MS, tz)
  const candidateBefore = wallAsUtcMs - offsetBefore
  if (offsetBefore === offsetAfter) return candidateBefore
  if (tzOffsetMsAt(candidateBefore, tz) === offsetBefore) return candidateBefore
  const candidateAfter = wallAsUtcMs - offsetAfter
  if (tzOffsetMsAt(candidateAfter, tz) === offsetAfter) return candidateAfter
  return candidateBefore
}

/**
 * Convert a naive local ISO datetime string to canonical UTC ISO.
 *
 * Input contract: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS". No Z. No offset.
 * The string is interpreted as a wall-clock time in the provided IANA timezone.
 * Seconds are accepted by the split but NOT read — only y/mo/d/h/min are parsed,
 * so the result is always minute-aligned. Long-standing behaviour, unchanged here.
 *
 * DST-correct by delegating to wallTimeToUtcMs above, which validates its
 * candidate against the offset actually in force at that candidate. See that
 * docstring for the nonexistent (spring-forward gap → shifted forward past the
 * gap) and ambiguous (fall-back → first occurrence) contracts.
 *
 * @param localIso Naive local ISO string
 * @param tz IANA timezone identifier (e.g. "Europe/Madrid")
 * @returns UTC ISO string with Z suffix
 */
export function localToUtc(localIso: string, tz: string): string {
  const [y, mo, d, h, min] = localIso.split(/[-T:]/).map(Number)
  return new Date(wallTimeToUtcMs(y, mo, d, h, min, tz)).toISOString()
}

// en-CA reliably produces YYYY-MM-DD; avoids toISOString() local-date pitfalls.
export function getLocalDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(date)
}

// Weekday short-name → Date.getDay() index. Locale-pinned to en-GB ("Sun".."Sat")
// so the mapping can never vary with the environment's default locale; the
// slice(0, 3) below tolerates ICU builds that append a period.
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export interface TzParts {
  year: number
  month: number    // 1–12
  day: number      // 1–31
  hour: number     // 0–23
  minute: number   // 0–59
  weekday: number  // 0=Sunday … 6=Saturday, matching Date.getDay()
}

/**
 * Wall-clock parts of a UTC instant in a named IANA timezone.
 *
 * Single Intl.DateTimeFormat probe (formatToParts) — the inverse direction of
 * localToUtc above. DST-correct by construction: Intl owns the offset work, so
 * a spring-forward or fall-back instant simply reports the wall clock actually
 * showing in `tz` at that instant.
 *
 * Throws RangeError on an invalid `tz` (Intl's own behaviour). Render-side
 * callers must validate first (isValidTimeZone) and fall back; write-side
 * callers must fail closed and surface the error.
 */
export function utcInstantToTzParts(instant: string | Date, tz: string): TzParts {
  const d = instant instanceof Date ? instant : new Date(instant)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  // Some ICU builds emit hour "24" for midnight under hour12: false — normalise to 0.
  const rawHour = parseInt(get('hour'), 10)
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(get('minute'), 10),
    weekday: WEEKDAY_INDEX[get('weekday').slice(0, 3)] ?? 0,
  }
}

/**
 * Pure calendar-date arithmetic on a YYYY-MM-DD key: returns the key `days`
 * days later (negative = earlier). Anchored on Date.UTC and read back through
 * getUTC* fields, so the result can never shift with the process/browser
 * timezone or DST, and no toISOString()-derived date ever escapes.
 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

// True iff `tz` is a timezone identifier Intl accepts. The one throw-free way
// to probe validity; used by render paths to fall back to UTC instead of
// crashing the component tree on a bad profiles.timezone value.
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
