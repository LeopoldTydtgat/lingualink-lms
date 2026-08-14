-- Per-student allowed class durations (NEW-A1).
-- Backfill existing rows to all three durations, then default new rows to 60-only.
ALTER TABLE public.students
  ADD COLUMN allowed_durations integer[] NOT NULL DEFAULT '{30,60,90}';

ALTER TABLE public.students
  ALTER COLUMN allowed_durations SET DEFAULT '{60}';

ALTER TABLE public.students
  ADD CONSTRAINT students_allowed_durations_valid
  CHECK (allowed_durations <@ ARRAY[30,60,90] AND array_length(allowed_durations, 1) >= 1);

-- Student-facing column: booking page reads it under the student session.
GRANT SELECT (allowed_durations) ON public.students TO authenticated;
