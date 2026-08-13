-- Adds assignments.notified_at: stamps when the homework-assigned email for a
-- lesson-scoped assignment was sent. NULL = not yet notified. The email now
-- fires at report submit (submitReport), not at modal save (reconcile route),
-- so this column is the dedupe across multiple modal saves and reopened
-- report resubmits. Applied live via Supabase SQL editor 13 Aug 2026.

ALTER TABLE public.assignments ADD COLUMN notified_at timestamptz;

-- Backfill: every lesson-scoped assignment existing at migration time was
-- already emailed at modal-save under the old code path.
UPDATE public.assignments SET notified_at = assigned_at WHERE lesson_id IS NOT NULL;
