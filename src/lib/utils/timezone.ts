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
