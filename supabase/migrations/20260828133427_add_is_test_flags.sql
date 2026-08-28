-- Add is_test flag to profiles and students for test-account exclusion
-- from billing, reports and exports. Applied live 28 Aug 2026.
alter table public.profiles add column if not exists is_test boolean not null default false;
alter table public.students add column if not exists is_test boolean not null default false;
grant select (is_test) on public.profiles to authenticated;
grant select (is_test) on public.students to authenticated;