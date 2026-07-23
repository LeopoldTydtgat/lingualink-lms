-- Back-fill: applied live on 17 Jul 2026, recorded for schema history — do not re-run against prod.
--
-- The teacher What's New per-item dismissal table (Session 209) was created in
-- the SQL editor and never recorded as a migration. This is the exact live DDL.
-- teacher_id here IS the auth uuid: profiles.id = auth.users.id for teachers,
-- so auth.uid() compares against it directly (unlike students, where the table
-- PK and the auth uuid differ).

create table if not exists public.whats_new_dismissals (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  item_key text not null,
  dismissed_at timestamptz not null default now(),
  unique (teacher_id, item_key)
);

alter table public.whats_new_dismissals enable row level security;

create policy "teachers select own dismissals"
  on public.whats_new_dismissals
  for select
  using (auth.uid() = teacher_id);

create policy "teachers insert own dismissals"
  on public.whats_new_dismissals
  for insert
  with check (auth.uid() = teacher_id);
