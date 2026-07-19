-- NEW345 step 6: sheet-level "mark as done" for assignments.
-- Replaces the legacy exercise_completions mark-done path (table dies in step 7).
ALTER TABLE assignments
  ADD COLUMN marked_done_at timestamptz NULL;

COMMENT ON COLUMN assignments.marked_done_at IS
  'Student marked this assignment done at sheet level. Set by /api/student/assignments mark-done route. Null means not marked. Assignment also counts complete when every activity on its sheet has an attempt (see assignmentCompletion.ts).';
