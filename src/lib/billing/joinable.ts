import { BLOCKED_STATUSES } from './billability'

/**
 * Single source of truth for "can this lesson's Join Class button be used right now."
 *
 * Window: the button is live ONLY when now is within 10 minutes before start
 * AND now is at or before the class end. Status guard blocks cancelled /
 * completed / no-show lessons as defense-in-depth (loaders also filter these,
 * but the rule must stand on its own).
 *
 * End boundary is `now > end` — the button stays usable through the final
 * second of the class and is gone the instant after end.
 */
export const JOIN_WINDOW_MS = 10 * 60 * 1000 // 10 minutes before start

export function isLessonJoinable(
  scheduledAt: string,
  durationMinutes: number,
  status: string,
  nowMs: number
): boolean {
  // Defense-in-depth: never joinable for a blocked status, regardless of timing.
  if (BLOCKED_STATUSES.includes(status)) return false

  const startMs = new Date(scheduledAt).getTime()
  const endMs = startMs + durationMinutes * 60 * 1000

  // Past the end -> gone (clickable through the exact end instant, gone after).
  if (nowMs > endMs) return false

  // Live only inside the 10-minute pre-start window (through the class).
  const msUntilStart = startMs - nowMs
  return msUntilStart <= JOIN_WINDOW_MS
}
