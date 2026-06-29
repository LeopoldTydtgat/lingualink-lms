-- Migration: capture live study_sheets audience column + four-tier SELECT RLS (NEW232)
-- Date: 2026-06-29
--
-- The `audience` column and the four tiered SELECT policies below were added
-- directly in the Supabase SQL editor across sessions 178-179 (NEW232 access
-- boundary). They were never captured in a repo migration, so the repo was
-- behind the live database. Three code paths now hard-depend on them:
--   - src/app/api/library-file/[sheetId]/[index]/route.ts  (authed PDF proxy)
--   - src/app/(student)/student/study/[id]/page.tsx         (student sheet detail)
--   - src/app/(student)/student/study/page.tsx              (student library list)
--
-- This migration is a VERBATIM capture of the live state (pulled from
-- information_schema.columns, pg_constraint, and pg_policies on 2026-06-29) so
-- the repo matches production and a from-scratch replay reproduces it exactly.
--
-- WHY THIS MATTERS: the baseline schema still creates the OLD permissive read
-- policy, "Authenticated users can view study sheets"
-- (USING auth.role() = 'authenticated'), which lets ANY logged-in user read
-- EVERY sheet. A database rebuilt from migrations without this file would have
-- no `audience` column (the three code paths above would error or return empty)
-- AND would restore that permissive policy, silently reopening the teacher-PDF
-- leak that sessions 178-179 closed. This file drops the old policy by name and
-- installs the four-tier replacement.
--
-- It is effectively a no-op against the live database: the column already
-- exists (guarded by IF NOT EXISTS), the old policy is already dropped live
-- (guarded by IF EXISTS), and the four policies already exist (dropped-then-
-- recreated below so a replay is deterministic). Do not edit the policy
-- expressions to "improve" them - they are ground truth as of 2026-06-29.


-- ============================================================
-- 1. audience column
-- ============================================================
-- text, NOT NULL, default 'staff'. The 'staff' default is fail-safe: an
-- unlabelled sheet hides from students, it never leaks.
ALTER TABLE public.study_sheets
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'staff';

-- CHECK constraint: audience must be 'student' or 'staff'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.study_sheets'::regclass
      AND conname = 'study_sheets_audience_check'
  ) THEN
    ALTER TABLE public.study_sheets
      ADD CONSTRAINT study_sheets_audience_check
      CHECK (audience = ANY (ARRAY['student'::text, 'staff'::text]));
  END IF;
END $$;


-- ============================================================
-- 2. drop the old permissive read policy
-- ============================================================
-- This is the leak. Created in the baseline schema. Must be gone on any rebuild.
DROP POLICY IF EXISTS "Authenticated users can view study sheets" ON public.study_sheets;


-- ============================================================
-- 3. the four tiered SELECT policies (verbatim from live pg_policies)
-- ============================================================
-- Dropped-then-created so a replay is deterministic regardless of prior state.

DROP POLICY IF EXISTS "Students view student sheets" ON public.study_sheets;
CREATE POLICY "Students view student sheets" ON public.study_sheets
  FOR SELECT TO authenticated
  USING (
    (audience = 'student'::text)
    AND (is_active = true)
    AND (EXISTS ( SELECT 1
           FROM students s
          WHERE (s.auth_user_id = auth.uid())))
  );

DROP POLICY IF EXISTS "Teachers view teacher sheets" ON public.study_sheets;
CREATE POLICY "Teachers view teacher sheets" ON public.study_sheets
  FOR SELECT TO authenticated
  USING (
    (EXISTS ( SELECT 1
        FROM profiles p
       WHERE ((p.id = auth.uid()) AND (p.account_types @> ARRAY['teacher'::text]))))
    AND ((audience = 'student'::text) OR (allowed_roles @> ARRAY['teacher'::text]))
  );

DROP POLICY IF EXISTS "Exam teachers view exam sheets" ON public.study_sheets;
CREATE POLICY "Exam teachers view exam sheets" ON public.study_sheets
  FOR SELECT TO authenticated
  USING (
    (EXISTS ( SELECT 1
        FROM profiles p
       WHERE ((p.id = auth.uid()) AND (p.account_types @> ARRAY['teacher_exam'::text]))))
    AND ((audience = 'student'::text) OR (allowed_roles @> ARRAY['teacher'::text]) OR (allowed_roles @> ARRAY['teacher_exam'::text]))
  );

DROP POLICY IF EXISTS "Admins view all sheets" ON public.study_sheets;
CREATE POLICY "Admins view all sheets" ON public.study_sheets
  FOR SELECT TO authenticated
  USING (is_admin());


-- ============================================================
-- Note: the admin INSERT/UPDATE/DELETE policies are NOT touched here.
-- They already exist correctly in the baseline schema and did not drift.
-- This migration captures only what changed: the column and the SELECT swap.
-- ============================================================