// Read-side check of a lesson's duration_minutes against students.allowed_durations
// (live column: integer[] NOT NULL DEFAULT '{60}', CHECK subset of {30,60,90} and
// non-empty, with a column-level SELECT grant to authenticated).
//
// INFORMATIONAL ONLY. Admin booking is deliberately exempt from the per-student
// duration rule, so an admin may create a lesson of a length the student could not
// have booked themselves. This helper exists so admin surfaces can SAY SO on the
// row; it gates nothing, refuses nothing, and has no write path. The real gates
// live in the student portal (api/student/book/route.ts) and stay untouched.
//
// THREE states, never a boolean:
//   'ok'          parsed to a non-empty number array that includes the duration
//   'not_allowed' parsed the same way, and it does NOT include the duration
//   'unknown'     null / undefined / not an array / empty / any non-numeric entry
//
// 'unknown' is the whole point of the three-state shape. The value can legitimately
// go missing from a render tree - it is absent from the staff-view column list on
// the admin student detail page unless explicitly selected, and any future select
// that forgets it would do the same - and a boolean would turn the marker silently
// OFF in exactly that case, which is indistinguishable from "every duration is
// fine". Callers must render 'unknown' as its own visible state and must NEVER
// collapse it into 'ok'.
//
// Deliberately NOT the same shape as the two student-portal call sites
// ((student)/student/book/page.tsx and api/student/book/route.ts). Those are
// fail-CLOSED gates on a WRITE: a malformed value must block a booking there, and
// the page one additionally sanitises to the three lengths the booking flow offers.
// This one only reports on a lesson that already exists, so it neither refuses nor
// filters: a legacy 45-minute allowance is reported as it is rather than silently
// reclassified as unreadable.

export type AllowedDurationsResult =
  | { state: 'ok'; durations: number[] }
  | { state: 'not_allowed'; durations: number[] }
  | { state: 'unknown'; durations: null }

/**
 * Pure. No clock, no timezone, no I/O - the same inputs always give the same
 * result, so it is safe to call in a render body on server and client alike.
 *
 * `allowed` is typed `unknown` on purpose: every caller reads it out of an
 * unvalidated shape (a `Record<string, unknown>` prop, or JSON from a route that
 * validates nothing on the way out), so the narrowing has to happen HERE rather
 * than being asserted away at the call site.
 */
export function checkAllowedDuration(
  allowed: unknown,
  durationMinutes: number
): AllowedDurationsResult {
  // Empty counts as unknown, not as "nothing is allowed": the DB CHECK forbids an
  // empty array, so seeing one means the value did not come from the column intact.
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return { state: 'unknown', durations: null }
  }

  const durations: number[] = []
  for (const entry of allowed) {
    // typeof alone would admit NaN and Infinity, neither of which can name a real
    // class length and both of which would render as a nonsense list. They belong
    // with the rest of the malformed values, in 'unknown'.
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return { state: 'unknown', durations: null }
    }
    durations.push(entry)
  }

  return durations.includes(durationMinutes)
    ? { state: 'ok', durations }
    : { state: 'not_allowed', durations }
}
