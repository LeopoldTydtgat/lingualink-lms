-- NEW291 + NEW292 catch-up migration: applied live in the Supabase
-- SQL Editor on 11 Jul 2026 and verified via information_schema
-- grant reads. This file captures the changes in the repo.
--
-- NEW291: admin oversight thread viewing was clobbering recipient
-- read state (read_at). New column admin_read_at tracks "seen by
-- admin" separately; read_at is recipient-only again. Historical
-- admin-sent rows backfilled (authored = seen).
alter table public.messages add column admin_read_at timestamptz;

update public.messages set admin_read_at = created_at
where sender_type = 'admin' and admin_read_at is null;

-- NEW292: recipient queries formerly used select('*') and the
-- table-level SELECT grant exposed admin_read_at to teachers and
-- students. Code now uses explicit column lists (commit fd956b4);
-- grants reduced to column level so admin_read_at has zero
-- privileges for authenticated. UPDATE (read_at) grant untouched.
revoke select, insert on public.messages from authenticated;

grant select (id, sender_id, sender_type, receiver_id, receiver_type,
  content, attachments, read_at, created_at)
  on public.messages to authenticated;

grant insert (sender_id, sender_type, receiver_id, receiver_type,
  content, attachments)
  on public.messages to authenticated;
