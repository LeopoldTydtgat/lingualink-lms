// Reconcile-before-write for timed 'specific' availability rows.
//
// THE BUG THIS EXISTS TO CLOSE: a drag on the Day-to-Day calendar is an
// assertion about a range ("this range is available" / "this range is
// unavailable"), but POST /api/teacher/availability only ever INSERTed. Its
// upsert conflict target is 'teacher_id,day_of_week,start_time,end_time', and
// all three of those columns are NULL on a 'specific' row; NULLs never collide
// under a plain UNIQUE, so the conflict arm is unreachable and every drag
// created another row. Two drags over the same minutes therefore left TWO rows
// behind: one visible rectangle backed by N records, a delete that appears to
// do nothing (the twin repaints identical pixels), and a green run permanently
// buried under a co-extensive red one, since both layers share zIndex 2 and the
// red one paints last.
//
// This helper is the pure half of the fix. Given the new range and the
// teacher's existing MANUAL specific rows that overlap it, it decides which
// rows the write must remove and which fragments must be written back so the
// parts lying OUTSIDE the new range survive untouched. Deliberately DB-free:
// the route does the I/O, this does the interval arithmetic, and the arithmetic
// is what the unit tests pin.
//
// SCOPE, ENFORCED BY THE CALLER, NOT HERE: `existing` must already be narrowed
// to type='specific' AND source='manual' rows for this teacher. google_sync
// rows are owned by the busy-sync cron (which writes them directly with the
// admin client and replaces its own generation each run) and the DELETE route
// refuses them outright, so they must never reach this function. 'holiday' rows
// are whole calendar-date spans with different semantics and are likewise out
// of scope.

export interface ExistingSpecificRow {
  id: string
  start_at: string // stored UTC instant (timestamptz)
  end_at: string // stored UTC instant (timestamptz)
  is_available: boolean
}

export interface NewSpecificRange {
  startMs: number
  endMs: number
  // Carried for the caller's benefit and read by nothing below on purpose: the
  // trim is POLARITY-BLIND. The new action wins over every manual specific row
  // in its range, available or not, so dragging "available" over an existing
  // "unavailable" block clears it exactly as it would clear another available
  // one. Branching on polarity here would recreate the buried-layer bug.
  isAvailable: boolean
}

export interface RemainderRow {
  start_at: string
  end_at: string
  is_available: boolean
}

export interface ReconcileSpecificResult {
  // Rows the new range supersedes, in full. Every id here is deleted.
  deleteIds: string[]
  // The surviving fragments of the deleted rows, covering only the minutes
  // outside the new range and keeping their original polarity.
  remainders: RemainderRow[]
}

// NOT local-date construction. CLAUDE.md's "never use toISOString() for local
// date construction" rule bans deriving a YYYY-MM-DD (or any wall-clock part)
// from a browser/server-local Date, which silently shifts the day; `ms` here is
// an epoch instant parsed straight out of a stored timestamptz, so this round
// trip is frame-free and exact. Do not "fix" this to a date helper.
function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString()
}

export function reconcileSpecific(
  newRange: NewSpecificRange,
  existing: ExistingSpecificRow[],
): ReconcileSpecificResult {
  const { startMs, endMs } = newRange
  const deleteIds: string[] = []
  const remainders: RemainderRow[] = []

  // Fail closed on a degenerate range. Nothing is "inside" a zero-or-negative
  // length window, so reconciling one could only delete rows it does not
  // actually cover. Returning an empty result makes the caller a plain insert,
  // which is exactly the pre-existing behaviour.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { deleteIds, remainders }
  }

  for (const row of existing) {
    const rowStart = Date.parse(row.start_at)
    const rowEnd = Date.parse(row.end_at)

    // An unparseable or inverted row is left alone: deleting a row we cannot
    // measure would destroy availability we cannot write back.
    if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd) || rowEnd <= rowStart) continue

    // Half-open [start, end) overlap, strict on both sides, so a row that
    // merely TOUCHES the new range at an endpoint (its end == the new start, or
    // its start == the new end) does not overlap and is never touched. This
    // matches the route's .lt('start_at', end_at) / .gt('end_at', start_at)
    // candidate filter exactly; the two must stay in step.
    if (rowStart >= endMs || rowEnd <= startMs) continue

    // Overlapping at all means the row goes: fully contained rows leave no
    // remainder, partially overlapping ones leave the 1 or 2 fragments below.
    deleteIds.push(row.id)

    // Left fragment: the part of the row that starts before the new range.
    if (rowStart < startMs) {
      remainders.push({
        start_at: toIsoInstant(rowStart),
        end_at: toIsoInstant(startMs),
        is_available: row.is_available,
      })
    }

    // Right fragment: the part of the row that runs past the new range. Both
    // fire together when the new range is strictly inside an existing row.
    if (rowEnd > endMs) {
      remainders.push({
        start_at: toIsoInstant(endMs),
        end_at: toIsoInstant(rowEnd),
        is_available: row.is_available,
      })
    }
  }

  return { deleteIds, remainders }
}
