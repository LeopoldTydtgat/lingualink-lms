-- Widen lesson overlap exclusion constraints beyond status = 'scheduled'.
-- Filing a report mid-class sets a terminal status while the slot is still
-- running, which dropped the row out of both partial exclusion constraints
-- and freed the slot for a second booking over a live class.
-- Guarded now: scheduled, completed, student_no_show, teacher_no_show, missed.
-- Excluded: the three cancelled variants.
-- status is NOT NULL, so the NOT IN predicate can never evaluate to NULL.
-- Applied live in the Supabase SQL Editor 11 Aug 2026.

BEGIN;

ALTER TABLE public.lessons DROP CONSTRAINT no_teacher_overlap;

ALTER TABLE public.lessons ADD CONSTRAINT no_teacher_overlap
  EXCLUDE USING gist (
    teacher_id WITH =,
    tstzrange(scheduled_at, lesson_end_time(scheduled_at, duration_minutes), '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'cancelled_by_student', 'cancelled_by_teacher'));

ALTER TABLE public.lessons DROP CONSTRAINT no_student_overlap;

ALTER TABLE public.lessons ADD CONSTRAINT no_student_overlap
  EXCLUDE USING gist (
    student_id WITH =,
    tstzrange(scheduled_at, lesson_end_time(scheduled_at, duration_minutes), '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'cancelled_by_student', 'cancelled_by_teacher'));

COMMIT;