-- Google Calendar OAuth connection storage (GCAL REBUILD 1).
-- One row per connected account (in practice: the sole admin).
-- RLS enabled with ZERO policies + REVOKE from anon/authenticated = deny-all
-- to every browser/session client. Only the service role reads or writes it.
-- Same pattern as calendar_feed_tokens, plus the explicit service_role GRANT
-- that migration omitted.
-- Applied live via Supabase SQL editor 22 Aug 2026; this file is the capture.

create table public.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  google_email text,
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  scope text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_connections enable row level security;

revoke all on public.google_calendar_connections from anon;
revoke all on public.google_calendar_connections from authenticated;

grant select, insert, update, delete on public.google_calendar_connections to service_role;
