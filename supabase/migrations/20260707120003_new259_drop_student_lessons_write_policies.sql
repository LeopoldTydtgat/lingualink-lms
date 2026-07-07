-- NEW259 - drop the two student-scoped write policies on lessons that are no
-- longer needed and, in the INSERT case, unsafe. The "Students insert own
-- lessons" INSERT policy constrained only student_id: teacher_id and status
-- were attacker-choosable, so a student could forge a lesson naming any
-- teacher and, via the NEW258 pending-report trigger, mint a pending report
-- against that teacher (a student-forgeable teacher no-show). The "Students
-- can cancel their own lessons" UPDATE policy was unused: cancellations go
-- through the cancel_lesson_atomic RPC on the service-role client, never a
-- direct student-session UPDATE. The student booking route's lesson INSERT
-- was moved to the admin client in the same fix, so no app code depends on
-- either policy.
--
-- Applied live via the Supabase SQL Editor on 07 Jul 2026 BEFORE this migration
-- file was written; this file is the repo catch-up record. IF EXISTS makes it
-- safe to run on an environment where the policies are already gone.

DROP POLICY IF EXISTS "Students insert own lessons" ON public.lessons;

DROP POLICY IF EXISTS "Students can cancel their own lessons" ON public.lessons;

-- Revoke the residual default table grants on public.lessons. The table was
-- left with anon and authenticated holding INSERT, UPDATE, DELETE and TRUNCATE.
-- With the student write policies dropped above, INSERT/UPDATE/DELETE were
-- already inert for those roles (no matching policy means RLS denies the write),
-- but two risks remained: TRUNCATE is not governed by RLS at all, and a dangling
-- write grant can silently reactivate if a permissive policy is ever added to
-- this table later. SELECT is deliberately retained for both roles: the read
-- policies (students read-own, teachers see-own) require the table-level SELECT
-- grant, and a missing SELECT grant makes PostgREST silently null entire rows.
--
-- Applied live via the Supabase SQL Editor on 07 Jul 2026 BEFORE this file was
-- updated; this section is the repo catch-up record.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lessons FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lessons FROM authenticated;
