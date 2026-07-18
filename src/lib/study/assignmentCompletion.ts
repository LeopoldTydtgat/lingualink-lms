// NEW345 bimodal assignment-completion rule, single-sourced.
//
// An assignment is complete when EITHER:
//   - a legacy `exercise_completions` row is keyed to its assignment_id, OR
//   - the sheet has >= 1 activity and every one of those activities has an
//     `activity_attempts` row under that assignment_id.
//
// Lifted verbatim from the two inline copies previously in
// study-sheets/page.tsx and students/[id]/page.tsx - no behavioural change.
// The returned predicate and the exposed `activityIdsBySheet` map reproduce
// exactly what those pages built inline.

type SheetActivityRow = { id: string; sheet_id: string }
type CompletionRow = { assignment_id: string | null }
type AttemptActivityRow = { activity_id: string; assignment_id: string | null }

export type AssignmentCompletion = {
  /** True when the given assignment (for the given sheet) is complete. */
  isComplete: (assignmentId: string, sheetId: string) => boolean
  /** sheet_id -> activity ids, reused by callers that also need activity counts. */
  activityIdsBySheet: Map<string, string[]>
}

export function buildAssignmentCompletion(
  activityRows: SheetActivityRow[],
  completionRows: CompletionRow[],
  attemptRows: AttemptActivityRow[],
): AssignmentCompletion {
  const activityIdsBySheet = new Map<string, string[]>()
  for (const a of activityRows) {
    const arr = activityIdsBySheet.get(a.sheet_id) ?? []
    arr.push(a.id)
    activityIdsBySheet.set(a.sheet_id, arr)
  }

  // Legacy path: an exercise_completions row keyed to the assignment means done.
  const legacyDoneAssignments = new Set<string>()
  for (const c of completionRows) {
    if (c.assignment_id) legacyDoneAssignments.add(c.assignment_id)
  }

  // NEW345 path: which activities each assignment has an attempt for.
  const attemptsByAssignment = new Map<string, Set<string>>()
  for (const t of attemptRows) {
    if (!t.assignment_id) continue
    const set = attemptsByAssignment.get(t.assignment_id) ?? new Set<string>()
    set.add(t.activity_id)
    attemptsByAssignment.set(t.assignment_id, set)
  }

  function isComplete(assignmentId: string, sheetId: string): boolean {
    if (legacyDoneAssignments.has(assignmentId)) return true
    const acts = activityIdsBySheet.get(sheetId)
    if (acts && acts.length > 0) {
      const done = attemptsByAssignment.get(assignmentId)
      if (done && acts.every(id => done.has(id))) return true
    }
    return false
  }

  return { isComplete, activityIdsBySheet }
}
