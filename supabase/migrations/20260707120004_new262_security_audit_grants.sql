-- NEW262 catch-up migration: pre-go-live security audit grant changes.
-- All statements below were applied live in the Supabase SQL Editor on
-- 07 Jul 2026 and verified by re-reads of information_schema grants,
-- pg_policies and pg_proc.proacl. This file captures them in the repo.
--
-- (1) students.teacher_notes was column-SELECT-granted to authenticated;
--     combined with the own-row RLS policy any student could read it.
REVOKE SELECT (teacher_notes) ON public.students FROM authenticated;

-- (2) profiles PII columns were SELECT-granted to authenticated under a
--     permissive read-all policy: any student could read any teacher's
--     phone, DOB and home address. All code readers of these columns use
--     the admin client, so revoking breaks nothing.
REVOKE SELECT (phone, date_of_birth, street_address, area_code, city, preferred_payment_type) ON public.profiles FROM authenticated;

-- (3) messages held FULL table grants (incl. UPDATE on all columns,
--     DELETE, TRUNCATE) for anon and authenticated; combined with the
--     'Recipients can mark as read' UPDATE policy a recipient could
--     rewrite content or sender of received messages. Reset to the
--     minimum the app needs: SELECT + INSERT, UPDATE on read_at only.
REVOKE ALL ON public.messages FROM anon, authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;
GRANT UPDATE (read_at) ON public.messages TO authenticated;

-- (4) Stray table-level DELETE grants on profiles and students.
REVOKE DELETE ON public.profiles FROM anon, authenticated;
REVOKE DELETE ON public.students FROM anon, authenticated;

-- (5) flag_overdue_reports (SECURITY DEFINER) had EXECUTE granted to
--     anon, authenticated AND (found later the same day) PUBLIC - the
--     PUBLIC grant silently re-opened access after the role revokes.
--     Execution is service-path only; the pg_cron job runs as postgres
--     and is unaffected.
REVOKE EXECUTE ON FUNCTION public.flag_overdue_reports() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.flag_overdue_reports() FROM anon, authenticated;

-- (6) Legacy classes table (dead - live table is lessons): strip all
--     anon/authenticated grants and drop its three stale policies.
--     Zero code references confirmed via findstr.
REVOKE ALL ON public.classes FROM anon, authenticated;
DROP POLICY IF EXISTS "Admins can manage all classes" ON public.classes;
DROP POLICY IF EXISTS "Teachers can update their own lesson notes" ON public.classes;
DROP POLICY IF EXISTS "Teachers can view their own classes" ON public.classes;
