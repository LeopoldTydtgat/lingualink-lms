-- GCAL REBUILD 2 step 1: outbound Google Calendar event pointer on lessons.
--
-- Applied live via the Supabase SQL Editor on 23 Aug 2026; this file is the
-- capture, written replay-safe.
--
-- DESIGN NOTES (verified live before applying, do not re-derive):
--   * NO column-level REVOKE. public.lessons carries a TABLE-level SELECT grant
--     to authenticated and had zero column-level revokes at the time of writing.
--     A table grant covers future columns automatically, so this column is
--     readable and every existing select('*') on lessons keeps working. Adding a
--     revoke here would first require stripping the table grant and re-granting
--     each column, and any select('*') left behind would silently return null
--     for the WHOLE row.
--   * Verified after apply: authenticated holds SELECT (and the pre-existing
--     dead REFERENCES) on this column; INSERT/UPDATE remain service_role and
--     postgres only. Writes stay server-side.
--   * Matches teams_meeting_id, which is the same class of value (an opaque
--     external id, useless without the corresponding API credential).
--   * NO unique index, deliberately: teams_meeting_id has none either, and a
--     unique constraint would turn an API-impossible collision into a 500 on
--     the booking path.

ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS google_event_id text;

COMMENT ON COLUMN public.lessons.google_event_id IS 'Google Calendar event id for this lesson, written by the outbound sync (GCAL REBUILD 2). Null when no Google Calendar is connected or the create failed. Retained on cancelled rows until the Google delete succeeds, so it doubles as the orphan pointer.';
