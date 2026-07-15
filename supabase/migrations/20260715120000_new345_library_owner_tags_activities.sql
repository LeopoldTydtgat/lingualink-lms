-- NEW345 Study Library rebuild - schema step 1 (15 Jul 2026)
-- Captured verbatim from live DB after execution via SQL Editor (one statement per box).
-- Teacher write policies (draft statements 5-7) intentionally NOT run:
--   5-6 held pending revised-policy review (D1: add p.status = 'current'; D2: include teacher_exam);
--   7 dropped entirely (D4): teacher delete = is_active flip via UPDATE policy. A hard DELETE
--   would cascade through lesson_annotations (20260630120000:32) and exercise_completions,
--   destroying rows the DB otherwise forbids deleting.

-- owner_id: NULL = admin library resource; non-null = teacher-owned private (staff-audience) material.
-- FK to profiles(id) is LOAD-BEARING: write policies will rely on owner_id = auth.uid() being
-- provably a staff uuid. Do not drop or repoint without adding account_types checks.
alter table public.study_sheets add column owner_id uuid references public.profiles(id) on delete cascade;

comment on column public.study_sheets.owner_id is 'NULL = admin library resource visible per audience/role tiers. Non-null = teacher-owned private material. FK to profiles(id) is load-bearing: future write policies rely on owner_id = auth.uid() being provably a staff uuid. Do not drop or repoint this FK without adding account_types checks to the write policies.';

-- Read tiers learn the owner rule. Live conjuncts preserved verbatim; owner clause appended.
alter policy "Students view student sheets" on public.study_sheets using ((audience = 'student') and (is_active = true) and (owner_id is null) and (exists (select 1 from students s where s.auth_user_id = auth.uid())));

alter policy "Teachers view teacher sheets" on public.study_sheets using ((exists (select 1 from profiles p where p.id = auth.uid() and p.account_types @> array['teacher'::text])) and ((audience = 'student') or (allowed_roles @> array['teacher'::text])) and (owner_id is null or owner_id = auth.uid()));

alter policy "Exam teachers view exam sheets" on public.study_sheets using ((exists (select 1 from profiles p where p.id = auth.uid() and p.account_types @> array['teacher_exam'::text])) and ((audience = 'student') or (allowed_roles @> array['teacher'::text]) or (allowed_roles @> array['teacher_exam'::text])) and (owner_id is null or owner_id = auth.uid()));

-- tags: unique (name, kind) per D3. Authenticated read-only; service_role writes.
create table public.tags (id uuid primary key default gen_random_uuid(), name text not null, kind text not null check (kind in ('topic','skill')), created_at timestamptz not null default now(), unique (name, kind));

revoke all on table public.tags from anon, authenticated;

grant select on table public.tags to authenticated;

grant all on table public.tags to service_role;

alter table public.tags enable row level security;

create policy "Authenticated read tags" on public.tags for select to authenticated using (true);

-- sheet_tags: visibility mirrors study_sheets RLS via EXISTS (policies evaluate as querying user).
create table public.sheet_tags (sheet_id uuid not null references public.study_sheets(id) on delete cascade, tag_id uuid not null references public.tags(id) on delete cascade, primary key (sheet_id, tag_id));

revoke all on table public.sheet_tags from anon, authenticated;

grant select on table public.sheet_tags to authenticated;

grant all on table public.sheet_tags to service_role;

alter table public.sheet_tags enable row level security;

create policy "Read tags of visible sheets" on public.sheet_tags for select to authenticated using (exists (select 1 from public.study_sheets s where s.id = sheet_tags.sheet_id));

-- activities: DELIBERATE DEVIATION from the standard "grant all columns to authenticated" workflow.
-- answer_key is EXCLUDED from the authenticated column SELECT grant so PostgREST can never serve it:
-- select=*, select=answer_key, and WHERE/ORDER filters on it all return 42501 (verified empirically
-- 15 Jul 2026 with a live teacher JWT). Do NOT "fix" this to a full table grant - that leaks every
-- answer key. No authenticated writes: all writes are service_role via server routes that grade
-- against answer_key server-side.
create table public.activities (id uuid primary key default gen_random_uuid(), sheet_id uuid not null references public.study_sheets(id) on delete cascade, position integer not null default 0, type text not null check (type in ('mcq','gap_fill','matching','reorder','flashcards','listening','writing_task','speaking_task','scenario')), title text, content jsonb not null default '{}'::jsonb, answer_key jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

revoke all on table public.activities from anon, authenticated;

grant select (id, sheet_id, position, type, title, content, created_at, updated_at) on public.activities to authenticated;

grant all on table public.activities to service_role;

alter table public.activities enable row level security;

create policy "Read activities of visible sheets" on public.activities for select to authenticated using (exists (select 1 from public.study_sheets s where s.id = activities.sheet_id));

-- activity_attempts: SELECT-only for authenticated. All writes service_role (server grades vs answer_key).
-- Teacher policy duplicates the trainings condition inside RLS-visible trainings: intersection can
-- only narrow, never widen. No recursion: trainings RLS -> get_teacher_training_ids() SECURITY DEFINER.
create table public.activity_attempts (id uuid primary key default gen_random_uuid(), student_id uuid not null references public.students(id) on delete cascade, activity_id uuid not null references public.activities(id) on delete cascade, assignment_id uuid references public.assignments(id) on delete set null, answers jsonb not null default '{}'::jsonb, score integer, needs_review boolean not null default false, teacher_feedback text, reviewed_by uuid references public.profiles(id) on delete set null, graded_at timestamptz, created_at timestamptz not null default now());

revoke all on table public.activity_attempts from anon, authenticated;

grant select on table public.activity_attempts to authenticated;

grant all on table public.activity_attempts to service_role;

alter table public.activity_attempts enable row level security;

create policy "Students read own attempts" on public.activity_attempts for select to authenticated using (student_id = get_current_student_id());

create policy "Teachers read their students attempts" on public.activity_attempts for select to authenticated using (exists (select 1 from public.trainings t where t.student_id = activity_attempts.student_id and (t.teacher_id = auth.uid() or t.id in (select get_teacher_training_ids()))));

create policy "Admins read all attempts" on public.activity_attempts for select to authenticated using (is_admin());