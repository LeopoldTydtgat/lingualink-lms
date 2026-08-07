-- calendar_feed_tokens: per-user secret tokens for the ICS live subscription feed.
-- Service-role only: RLS enabled with NO policies (deny-all for clients),
-- plus explicit REVOKEs from anon and authenticated. Applied live 6 Aug 2026.

create table public.calendar_feed_tokens (
  id uuid primary key default gen_random_uuid(),
  user_type text not null check (user_type in ('teacher', 'student')),
  user_id uuid not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  unique (user_type, user_id)
);

alter table public.calendar_feed_tokens enable row level security;

revoke all on public.calendar_feed_tokens from anon;
revoke all on public.calendar_feed_tokens from authenticated;
