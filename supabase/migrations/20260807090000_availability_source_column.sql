-- Record of DDL ALREADY EXECUTED live via the Supabase SQL Editor, 7 Aug 2026.
-- Adds a source marker so the Google busy-sync cron can own and reconcile its
-- rows without ever touching manually created availability.
ALTER TABLE public.availability
  ADD COLUMN source text NOT NULL DEFAULT 'manual';

ALTER TABLE public.availability
  ADD CONSTRAINT availability_source_check
  CHECK (source IN ('manual', 'google_sync'));
