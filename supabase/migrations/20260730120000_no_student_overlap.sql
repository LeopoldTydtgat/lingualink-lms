-- Migration: capture the no_student_overlap exclusion constraint on public.lessons.
-- Date: 2026-07-30
--
-- Student-side counterpart to no_teacher_overlap. Where no_teacher_overlap forbids
-- two overlapping 'scheduled' lessons for the same TEACHER, this forbids two
-- overlapping 'scheduled' lessons for the same STUDENT. Applied live via the
-- Supabase SQL Editor on 30 Jul 2026; this file is the repo capture so a
-- from-scratch replay reproduces the live state.
--
-- Definition below is verbatim the live constraint. Notes:
--   - Half-open '[)' bounds: back-to-back lessons (one ending exactly when the
--     next starts) do NOT conflict.
--   - Partial WHERE status = 'scheduled': cancelled / completed / no-show /
--     missed rows never block a new booking, and a row leaving 'scheduled'
--     leaves the constraint's scope.
--   - Depends on the btree_gist extension (for the student_id WITH = operator)
--     and on public.lesson_end_time(timestamptz, integer). Both already exist:
--     no_teacher_overlap in the baseline schema relies on the same two.
--
-- Violations reach PostgREST as SQLSTATE 23P01 carrying the constraint name in
-- the error text, which the booking routes match on to tell a student clash
-- apart from a teacher clash.
--
-- NOT idempotent: replaying this against the live database errors with
-- "constraint no_student_overlap already exists" (ADD CONSTRAINT has no
-- IF NOT EXISTS form). It is here for from-scratch rebuilds only.

ALTER TABLE public.lessons
  ADD CONSTRAINT no_student_overlap
  EXCLUDE USING gist (
    student_id WITH =,
    tstzrange(scheduled_at, public.lesson_end_time(scheduled_at, duration_minutes), '[)') WITH &&
  )
  WHERE (status = 'scheduled');
