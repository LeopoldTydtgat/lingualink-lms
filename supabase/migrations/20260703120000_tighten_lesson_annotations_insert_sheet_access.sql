-- Migration: tighten lesson_annotations INSERT/UPDATE to require teacher study-sheet access
-- Date: 2026-07-03
--
-- ROOT-CAUSE FIX for the self-mint escalation found during Milestone 4 Piece 2 review.
--
-- BEFORE: the INSERT/UPDATE WITH CHECK verified only that the caller owns the lesson
-- (lessons.teacher_id = auth.uid()) and is before cutoff. It did NOT verify the caller
-- has any right to the study_sheet the row points at. A teacher could therefore mint an
-- annotation row for an ARBITRARY study_sheet_id -- including staff-audience Teaching
-- Material they are otherwise walled off from -- and (via a reader that trusts the row)
-- reach that sheet's bytes, bypassing the audience gate. A dual-role account (both a
-- teacher and, separately, a student) could use this to leak staff material to itself.
--
-- AFTER: INSERT/UPDATE additionally require that study_sheet_id passes the SAME teacher
-- visibility predicate already enforced by the live study_sheets SELECT policies
-- ("Teachers view teacher sheets" and "Exam teachers view exam sheets"). Annotation
-- write access now lines up exactly with sheet read access -- a teacher can only
-- annotate a sheet they can already see. No behaviour change for legitimate annotation
-- (a teacher annotating material they teach from); the arbitrary-UUID power is removed.
--
-- The two visibility branches below are copied VERBATIM from the live study_sheets
-- policies (pg_policies, 2026-07-03) so annotation access cannot drift from sheet access:
--   teacher:      account_types @> ARRAY['teacher']      AND (audience='student' OR allowed_roles @> ARRAY['teacher'])
--   exam teacher: account_types @> ARRAY['teacher_exam'] AND (audience='student' OR allowed_roles @> ARRAY['teacher'] OR allowed_roles @> ARRAY['teacher_exam'])
--
-- Lesson-ownership + cutoff logic is UNCHANGED from migration 20260630120000.
-- Admin write is still not granted (unchanged). Student write is still not granted (unchanged).

DROP POLICY IF EXISTS "Teachers insert own lesson annotations before cutoff" ON public.lesson_annotations;

CREATE POLICY "Teachers insert own lesson annotations before cutoff"
  ON public.lesson_annotations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.lessons l
      WHERE l.id = lesson_annotations.lesson_id
        AND l.teacher_id = auth.uid()
        AND now() < public.lesson_end_time(l.scheduled_at, l.duration_minutes) + interval '15 minutes'
    )
    AND EXISTS (
      SELECT 1
      FROM public.study_sheets s
      WHERE s.id = lesson_annotations.study_sheet_id
        AND (
          (
            EXISTS (
              SELECT 1 FROM public.profiles p
              WHERE p.id = auth.uid()
                AND p.account_types @> ARRAY['teacher'::text]
            )
            AND (
              s.audience = 'student'::text
              OR s.allowed_roles @> ARRAY['teacher'::text]
            )
          )
          OR
          (
            EXISTS (
              SELECT 1 FROM public.profiles p
              WHERE p.id = auth.uid()
                AND p.account_types @> ARRAY['teacher_exam'::text]
            )
            AND (
              s.audience = 'student'::text
              OR s.allowed_roles @> ARRAY['teacher'::text]
              OR s.allowed_roles @> ARRAY['teacher_exam'::text]
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "Teachers update own lesson annotations before cutoff" ON public.lesson_annotations;

CREATE POLICY "Teachers update own lesson annotations before cutoff"
  ON public.lesson_annotations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.lessons l
      WHERE l.id = lesson_annotations.lesson_id
        AND l.teacher_id = auth.uid()
        AND now() < public.lesson_end_time(l.scheduled_at, l.duration_minutes) + interval '15 minutes'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.lessons l
      WHERE l.id = lesson_annotations.lesson_id
        AND l.teacher_id = auth.uid()
        AND now() < public.lesson_end_time(l.scheduled_at, l.duration_minutes) + interval '15 minutes'
    )
    AND EXISTS (
      SELECT 1
      FROM public.study_sheets s
      WHERE s.id = lesson_annotations.study_sheet_id
        AND (
          (
            EXISTS (
              SELECT 1 FROM public.profiles p
              WHERE p.id = auth.uid()
                AND p.account_types @> ARRAY['teacher'::text]
            )
            AND (
              s.audience = 'student'::text
              OR s.allowed_roles @> ARRAY['teacher'::text]
            )
          )
          OR
          (
            EXISTS (
              SELECT 1 FROM public.profiles p
              WHERE p.id = auth.uid()
                AND p.account_types @> ARRAY['teacher_exam'::text]
            )
            AND (
              s.audience = 'student'::text
              OR s.allowed_roles @> ARRAY['teacher'::text]
              OR s.allowed_roles @> ARRAY['teacher_exam'::text]
            )
          )
        )
    )
  );
