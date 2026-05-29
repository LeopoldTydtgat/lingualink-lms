// src/lib/time/requireTz.ts
// Fail-closed timezone access. Post-S111 the timezone column is non-null;
// any null reaching here is a real schema violation and must surface, not
// silently default to a wrong zone (which mis-renders class times or
// mis-buckets billing). Mirrors the TIMEZONE_MISSING throws from S111/S112.
export function requireTz(tz: string | null | undefined, context: string): string {
  if (!tz) throw new Error(`TIMEZONE_MISSING:${context}`)
  return tz
}
