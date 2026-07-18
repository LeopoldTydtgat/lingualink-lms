// NEW345 bimodal assignment-completion rule, single-sourced.
//
// An assignment is complete when EITHER:
//   - its `assignments.marked_done_at` is set (the student marked the whole
//     sheet done - the completion path for a sheet with zero activities), OR
//   - the sheet has >= 1 activity and every one of those activities has an
//     `activity_attempts` row under that assignment_id.
//
// The returned predicate and the exposed `activityIdsBySheet` map are shared by
// every caller that displays worksheet progress.

type SheetActivityRow = { id: string; sheet_id: string }
type AttemptActivityRow = { activity_id: string; assignment_id: string | null }

export type AssignmentCompletion = {
  /** True when the given assignment (for the given sheet) is complete. */
  isComplete: (assignmentId: string, sheetId: string) => boolean
  /** sheet_id -> activity ids, reused by callers that also need activity counts. */
  activityIdsBySheet: Map<string, string[]>
}

export function buildAssignmentCompletion(
  activityRows: SheetActivityRow[],
  markedDoneAssignmentIds: Set<string>,
  attemptRows: AttemptActivityRow[],
): AssignmentCompletion {
  const activityIdsBySheet = new Map<string, string[]>()
  for (const a of activityRows) {
    const arr = activityIdsBySheet.get(a.sheet_id) ?? []
    arr.push(a.id)
    activityIdsBySheet.set(a.sheet_id, arr)
  }

  // Which activities each assignment has an attempt for.
  const attemptsByAssignment = new Map<string, Set<string>>()
  for (const t of attemptRows) {
    if (!t.assignment_id) continue
    const set = attemptsByAssignment.get(t.assignment_id) ?? new Set<string>()
    set.add(t.activity_id)
    attemptsByAssignment.set(t.assignment_id, set)
  }

  function isComplete(assignmentId: string, sheetId: string): boolean {
    if (markedDoneAssignmentIds.has(assignmentId)) return true
    const acts = activityIdsBySheet.get(sheetId)
    if (acts && acts.length > 0) {
      const done = attemptsByAssignment.get(assignmentId)
      if (done && acts.every(id => done.has(id))) return true
    }
    return false
  }

  return { isComplete, activityIdsBySheet }
}
