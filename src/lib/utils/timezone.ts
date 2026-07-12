/**
 * Convert a naive local ISO datetime string to canonical UTC ISO.
 *
 * Input contract: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS". No Z. No offset.
 * The string is interpreted as a wall-clock time in the provided IANA timezone.
 *
 * DST-correct via two-pass Intl probe.
 *
 * @param localIso Naive local ISO string
 * @param tz IANA timezone identifier (e.g. "Europe/Madrid")
 * @returns UTC ISO string with Z suffix
 */
export function localToUtc(localIso: string, tz: string): string {
  const [y, mo, d, h, min] = localIso.split(/[-T:]/).map(Number)
  const probe = new Date(Date.UTC(y, mo - 1, d, h, min, 0))
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(probe)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value)
  const diffMs = Date.UTC(y, mo - 1, d, h, min, 0)
               - Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), 0)
  return new Date(probe.getTime() + diffMs).toISOString()
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
