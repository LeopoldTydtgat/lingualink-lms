-- Applied live in Supabase SQL Editor on 11 Aug 2026 (S548).
-- Self-study content system: two new categories and their content columns.

ALTER TABLE public.study_sheets
  DROP CONSTRAINT study_sheets_category_check,
  ADD CONSTRAINT study_sheets_category_check
    CHECK (category = ANY (ARRAY['vocabulary'::text, 'grammar'::text, 'listening'::text, 'reading'::text]));

ALTER TABLE public.study_sheets
  ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN reading_text text;