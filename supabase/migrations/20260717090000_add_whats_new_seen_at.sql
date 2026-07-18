-- Applied live via SQL Editor 17 Jul 2026; recorded here for migration truthfulness.
alter table public.profiles
  add column if not exists whats_new_seen_at timestamptz;
