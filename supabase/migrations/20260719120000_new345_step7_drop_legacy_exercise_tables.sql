-- NEW345 step 7: drop legacy exercises system tables.
-- Applied live via SQL Editor on 19 Jul 2026 (Session 225). Both tables
-- verified empty pre-drop, no FK/policy/function dependents remained.
-- Captured after the fact per DDL workflow.

drop table if exists public.exercise_completions;
drop table if exists public.exercises;
