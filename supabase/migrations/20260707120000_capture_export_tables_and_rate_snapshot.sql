-- Capture-only migration: these objects ALREADY EXIST in the live Supabase DB.
-- Created 06 Jul 2026 via SQL Editor during the admin reports Excel export build.
-- This file brings the repo's migrations in line with the live schema.
-- Safe to run on a fresh DB; guarded so it is a no-op against the live DB.

-- ============================================================
-- 1. lesson_rate_snapshots
--    Per-lesson snapshot of the teacher's hourly rate at booking
--    time. One row per lesson (UNIQUE). Written only by the
--    snapshot trigger below. Deny-all RLS; service-role access only.
-- ============================================================

create table if not exists public.lesson_rate_snapshots (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  hourly_rate numeric,
  captured_at timestamptz not null default now(),
  constraint lesson_rate_snapshots_lesson_id_key unique (lesson_id)
);

alter table public.lesson_rate_snapshots enable row level security;
-- Deny-all: RLS enabled with NO policies. Service role bypasses RLS.
revoke all on table public.lesson_rate_snapshots from anon, authenticated;

-- ============================================================
-- 2. lesson_join_clicks
--    One row per Join Class button click (teacher or student).
--    Currently empty - join buttons are not wired yet.
--    Deny-all RLS; service-role access only.
-- ============================================================

create table if not exists public.lesson_join_clicks (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  user_type text not null check (user_type = any (array['teacher'::text, 'student'::text])),
  user_id uuid not null,
  clicked_at timestamptz not null default now()
);

alter table public.lesson_join_clicks enable row level security;
revoke all on table public.lesson_join_clicks from anon, authenticated;

-- ============================================================
-- 3. export_log
--    Audit log: one row per admin reports export.
--    Deny-all RLS; service-role access only.
-- ============================================================

create table if not exists public.export_log (
  id uuid primary key default gen_random_uuid(),
  exported_by uuid not null references public.profiles(id),
  date_from date,
  date_to date,
  filters jsonb,
  row_count integer,
  exported_at timestamptz not null default now()
);

alter table public.export_log enable row level security;
revoke all on table public.export_log from anon, authenticated;

-- ============================================================
-- 4. Rate snapshot trigger
--    Upserts the teacher's current hourly_rate into
--    lesson_rate_snapshots on lesson insert and on any change
--    of teacher_id (teacher swap re-snapshots the new rate).
-- ============================================================

create or replace function public.snapshot_lesson_rate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into lesson_rate_snapshots (lesson_id, hourly_rate)
  select new.id, p.hourly_rate from profiles p where p.id = new.teacher_id
  on conflict (lesson_id) do update
    set hourly_rate = excluded.hourly_rate,
        captured_at = now();
  return new;
end;
$$;

-- Trigger functions cannot be called directly, but project rule:
-- always strip default EXECUTE grants from new functions.
revoke execute on function public.snapshot_lesson_rate() from public, anon, authenticated;

drop trigger if exists trg_snapshot_lesson_rate on public.lessons;
create trigger trg_snapshot_lesson_rate
  after insert or update of teacher_id on public.lessons
  for each row execute function public.snapshot_lesson_rate();
