-- Partial unique index: at most ONE active training per student.
-- Belt-and-braces under create_training_atomic (RPC serialises via student
-- row lock; this index is the DB-level backstop against any other write path).
-- Applied live 2026-08-04.

CREATE UNIQUE INDEX one_active_training_per_student
  ON public.trainings (student_id)
  WHERE status = 'active';
