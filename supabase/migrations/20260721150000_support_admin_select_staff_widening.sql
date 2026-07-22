-- ROLE-5a: widen support_messages admin SELECT policy to staff-or-admin.
-- Staff (account_types contains 'staff', status = 'current') may read support
-- threads so the support inbox works for staff accounts. All other
-- support_messages policies unchanged. Applied live 21 Jul 2026 via SQL
-- editor; this migration backfills the repo. Idempotent.

drop policy if exists support_admin_select on public.support_messages;

create policy support_admin_select on public.support_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and (
          p.role = 'admin'
          or ('staff' = any(p.account_types) and p.status = 'current')
        )
    )
  );