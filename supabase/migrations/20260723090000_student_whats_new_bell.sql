-- Back-fill: applied live on 23 Jul 2026, recorded for schema history — do not re-run against prod.
--
-- Student sibling of the teacher What's New system:
--   1. student_whats_new_dismissals — per-item dismissals, keyed on the AUTH
--      uuid (student_auth_id = auth.uid() = students.auth_user_id), NOT the
--      students table PK. Feed queries scope on students.id; dismissals scope
--      on auth.uid(). Never mix the two.
--   2. students.whats_new_seen_at — the bell's "seen" stamp. Column-level
--      SELECT grant to authenticated, NO write grant: writes go through the
--      service-role client only (actions/studentWhatsNewSeen.ts), mirroring
--      profiles.whats_new_seen_at.

create table if not exists public.student_whats_new_dismissals (
  id uuid primary key default gen_random_uuid(),
  student_auth_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  dismissed_at timestamptz not null default now(),
  unique (student_auth_id, item_key)
);

alter table public.student_whats_new_dismissals enable row level security;

create policy "students select own dismissals"
  on public.student_whats_new_dismissals
  for select
  using (auth.uid() = student_auth_id);

create policy "students insert own dismissals"
  on public.student_whats_new_dismissals
  for insert
  with check (auth.uid() = student_auth_id);

grant select, insert on public.student_whats_new_dismissals to authenticated;

alter table public.students
  add column if not exists whats_new_seen_at timestamptz;

grant select (whats_new_seen_at) on public.students to authenticated;
