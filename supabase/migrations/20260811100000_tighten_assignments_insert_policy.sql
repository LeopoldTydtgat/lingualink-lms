-- Tighten assignments INSERT policy (S552, closes MED RLS gap S487).
-- Previous with_check only guarded assigned_by + sheet predicate, so any
-- teacher could insert homework rows for any student. Now requires one of:
--   1. admin caller (is_admin()) - keeps the admin assign route working,
--   2. a trainings link between caller and student (teacher_id or
--      training_teachers junction, mirroring the SELECT policy),
--   3. caller is the teacher of the referenced lesson AND the lesson
--      belongs to the same student (covers the report modal write shape
--      regardless of junction table state after a substitute swap).

ALTER POLICY "Teachers can insert assignments" ON public.assignments
WITH CHECK (
  assigned_by = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.study_sheets ss
    WHERE ss.id = assignments.study_sheet_id
      AND ss.is_active = true
      AND ss.audience = 'student'
      AND ss.owner_id IS NULL
  )
  AND (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM public.trainings t
      WHERE t.student_id = assignments.student_id
        AND (t.teacher_id = (SELECT auth.uid())
             OR t.id IN (SELECT public.get_teacher_training_ids()))
    )
    OR EXISTS (
      SELECT 1 FROM public.lessons l
      WHERE l.id = assignments.lesson_id
        AND l.teacher_id = (SELECT auth.uid())
        AND l.student_id = assignments.student_id
    )
  )
);
