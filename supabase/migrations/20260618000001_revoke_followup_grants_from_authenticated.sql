-- Revoke column-level SELECT on admin-only follow-up fields from the authenticated role.
--
-- follow_up_date and follow_up_reason on profiles (teachers) and students are
-- admin-only fields per the project brief's must-not-leak rule. They had a
-- column-level GRANT SELECT to authenticated, meaning a teacher or student
-- query naming these columns (or select('*')) could read them. admin_notes and
-- cancellation_policy were already correctly withheld; only the follow-up pair
-- was exposed. Admin reads use the service-role client, which bypasses these
-- grants, so admin functionality is unaffected.

REVOKE SELECT(follow_up_date) ON TABLE public.profiles FROM authenticated;
REVOKE SELECT(follow_up_reason) ON TABLE public.profiles FROM authenticated;
REVOKE SELECT(follow_up_date) ON TABLE public.students FROM authenticated;
REVOKE SELECT(follow_up_reason) ON TABLE public.students FROM authenticated;
