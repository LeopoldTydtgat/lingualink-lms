-- 20260805120000_whats_new_backfill_and_grants.sql
-- Captures three pieces of live-only DDL:
--   1. whats_new_dismissals backfill (table created live ~19 Jul, never captured)
--   2. F22 REVOKE applied live 5 Aug 2026 (dismissal tables tightened to SELECT + INSERT)
--   3. profiles.whats_new_seen_at drop (dead since 242b2b7, teacher bell removed; applied live 5 Aug 2026)
-- Idempotent: safe to re-run.

-- 1. whats_new_dismissals (teacher What's New feed dismissal keys)
CREATE TABLE IF NOT EXISTS public.whats_new_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, item_key)
);

ALTER TABLE public.whats_new_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teachers select own dismissals" ON public.whats_new_dismissals;
CREATE POLICY "teachers select own dismissals" ON public.whats_new_dismissals
  FOR SELECT USING (auth.uid() = teacher_id);

DROP POLICY IF EXISTS "teachers insert own dismissals" ON public.whats_new_dismissals;
CREATE POLICY "teachers insert own dismissals" ON public.whats_new_dismissals
  FOR INSERT WITH CHECK (auth.uid() = teacher_id);

-- 2. F22: dismissal tables carry exactly SELECT + INSERT for authenticated, nothing for anon
--    (TRUNCATE from authenticated could wipe every user's dismissals; UPDATE/DELETE allow
--    resurrection of dismissed items; none are needed by any code path)
REVOKE ALL ON public.whats_new_dismissals FROM authenticated, anon;
GRANT SELECT, INSERT ON public.whats_new_dismissals TO authenticated;

REVOKE ALL ON public.student_whats_new_dismissals FROM authenticated, anon;
GRANT SELECT, INSERT ON public.student_whats_new_dismissals TO authenticated;

REVOKE ALL ON public.announcement_dismissals FROM authenticated, anon;
GRANT SELECT, INSERT ON public.announcement_dismissals TO authenticated;

-- 3. Dead column: teacher bell removed in 242b2b7, no reader or writer since.
--    students.whats_new_seen_at is a SEPARATE column on students and is kept.
ALTER TABLE public.profiles DROP COLUMN IF EXISTS whats_new_seen_at;
