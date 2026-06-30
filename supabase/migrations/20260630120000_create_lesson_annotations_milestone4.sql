-- Migration: create lesson_annotations + RLS for PDF annotation persistence (Milestone 4)
-- Date: 2026-06-30
--
-- New table storing the teacher's PDF annotation overlay (the single JSON-serializable
-- array from PdfViewer.tsx: pen strokes with 0..1 page-fraction points + text boxes),
-- one row per (lesson, study_sheet, attachment index in study_sheets.attachments).
-- The original library PDF is never modified; annotations are a separate overlay.
--
-- Access model (enforced ENTIRELY by the RLS policies below):
--   cutoff = lesson_end_time(scheduled_at, duration_minutes) + interval '15 minutes'
--   - Teacher (lessons.teacher_id) may INSERT/UPDATE only while now() < cutoff.
--   - Teacher may SELECT own-lesson rows at ANY time (read-only review after cutoff).
--   - Student (lessons.student_id) may SELECT only while now() >= cutoff (final copy).
--     Students never INSERT/UPDATE/DELETE.
--   - Admin (is_admin()) may SELECT all. No admin write.
--
-- Identity resolution copies established patterns:
--   teacher: lessons.teacher_id = auth.uid()         (teacher_id -> profiles.id = auth.uid())
--   student: lessons.student_id = public.get_current_student_id()
--            (= SELECT id FROM students WHERE auth_user_id = auth.uid())
--
-- updated_at is APP-MANAGED: this DB has no updated_at trigger (established pattern),
-- so the write path must set updated_at = now() on every UPDATE/upsert.
--
-- IMPORTANT (wiring, later milestone): write annotations through the USER-SCOPED client
-- (src/lib/supabase/server.ts), NEVER createAdminClient() -- the service-role client
-- bypasses RLS and therefore the entire ownership + cutoff gate.

CREATE TABLE public.lesson_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  study_sheet_id uuid NOT NULL REFERENCES public.study_sheets(id) ON DELETE CASCADE,
  attachment_index integer NOT NULL CHECK (attachment_index >= 0),
  annotations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lesson_annotations_unique_pdf UNIQUE (lesson_id, study_sheet_id, attachment_index)
);

CREATE INDEX lesson_annotations_study_sheet_id_idx
  ON public.lesson_annotations (study_sheet_id);

ALTER TABLE public.lesson_annotations ENABLE ROW LEVEL SECURITY;

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
  );

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
  );

CREATE POLICY "Teachers read own lesson annotations"
  ON public.lesson_annotations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.lessons l
      WHERE l.id = lesson_annotations.lesson_id
        AND l.teacher_id = auth.uid()
    )
  );

CREATE POLICY "Students read final lesson annotations after cutoff"
  ON public.lesson_annotations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.lessons l
      WHERE l.id = lesson_annotations.lesson_id
        AND l.student_id = public.get_current_student_id()
        AND now() >= public.lesson_end_time(l.scheduled_at, l.duration_minutes) + interval '15 minutes'
    )
  );

CREATE POLICY "Admins read all lesson annotations"
  ON public.lesson_annotations
  FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.lesson_annotations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lesson_annotations TO service_role;
