-- Migration: add owner clause to lesson_annotations INSERT/UPDATE sheet-visibility predicate
-- Date: 2026-07-15 (ALREADY EXECUTED in SQL Editor 15 Jul 2026; live pg_policies verified matching)
--
-- NEW345 pre-condition 2. Migration 20260703120000 copied the teacher/exam
-- study_sheets visibility predicate into the lesson_annotations WITH CHECK so
-- annotation write access lines up with sheet read access. The study_sheets
-- SELECT tiers now carry an owner clause (owner_id IS NULL OR owner_id =
-- auth.uid()); without mirroring it here, teacher A could mint an annotation
-- against teacher B's private sheet and the student pulls B's bytes via
-- /api/lesson-annotation-file -- the exact hole 20260703120000 closed,
-- reopened by its own copy.
--
-- The owner clause sits INSIDE each visibility branch, matching the per-tier
-- structure of the live study_sheets SELECT policies (pg_policies, 2026-07-15),
-- so a dual-role (teacher + teacher_exam) account cannot escape through the
-- other branch, and branch-by-branch drift audits stay 1:1.
--
-- SUPERSEDES the predicate copies in two earlier files. Do NOT re-paste either
-- to "restore" policies -- both are now owner-less and would strip the clause:
--   20260703120000 (its header lists the predicates without the owner clause)
--   20260629120000:78-96 (recreates both study_sheets tiers owner-less)
--
-- Lesson-ownership + cutoff logic UNCHANGED from 20260703120000. Admin and
-- student write still not granted (unchanged). Not retroactive: all sheets
-- were owner_id NULL at execution time, so no existing row changed writability.
-- NOTE: this gate is write-time only. The annotation reader route never
-- re-checks sheet visibility, so backfilling owner_id onto an already-annotated
-- sheet does NOT revoke existing annotations. If NEW345 ever backfills
-- owner_id, that must be handled separately.

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
            AND (s.owner_id IS NULL OR s.owner_id = auth.uid())
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
            AND (s.owner_id IS NULL OR s.owner_id = auth.uid())
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
            AND (s.owner_id IS NULL OR s.owner_id = auth.uid())
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
            AND (s.owner_id IS NULL OR s.owner_id = auth.uid())
          )
        )
    )
  );
