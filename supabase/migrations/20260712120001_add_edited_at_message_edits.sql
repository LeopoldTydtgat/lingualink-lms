-- Edit-own-message support: applied live in the Supabase SQL Editor on
-- 12 Jul 2026. This file captures the change in the repo.
--
-- edited_at marks a message as edited (content-only edits; attachments
-- are never modified by an edit). All content edits run through server
-- code via the admin client after an explicit ownership check —
-- authenticated has no UPDATE grant on content for either table.
alter table public.messages add column edited_at timestamptz;

alter table public.support_messages add column edited_at timestamptz;

-- messages SELECT/INSERT are column-level since NEW292, so the new
-- column needs its own SELECT grant or any authenticated thread fetch
-- that selects edited_at fails with 42501 permission denied.
-- support_messages SELECT remains table-level and already covers the
-- new column. No INSERT/UPDATE grant on edited_at for authenticated —
-- it is written only server-side via the service role.
grant select (edited_at) on public.messages to authenticated;
