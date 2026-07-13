-- Support-messages grants fix: applied live in the Supabase SQL Editor
-- on 12 Jul 2026. This file captures the change in the repo.
--
-- authenticated previously held broad table-level privileges on
-- public.support_messages; browser code only ever writes read_at
-- (ChatWidget / AdminSupportClient read receipts). Reduce authenticated
-- UPDATE to column level (read_at only) and strip the remaining write
-- privileges so content edits MUST go through server code (admin client)
-- after an explicit ownership check, mirroring the messages table.
revoke update, delete, truncate, references, trigger on public.support_messages from authenticated, anon;

grant update (read_at) on public.support_messages to authenticated;
