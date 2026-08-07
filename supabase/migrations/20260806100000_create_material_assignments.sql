-- material_assignments: teaching-material homework grants (Option B, client-approved 5 Aug)
-- Applied live via Supabase SQL Editor 6 Aug 2026. Additive only.
-- Grant row = permission slip (mirrors lesson_annotations pattern).
-- Student homework layer lives ON the row (annotations jsonb).
-- Page indices in annotations are REAL document pages.

create table public.material_assignments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  study_sheet_id uuid not null references public.study_sheets(id) on delete cascade,
  attachment_index integer not null check (attachment_index >= 0),
  attachment_name text not null,
  page_start integer,
  page_end integer,
  annotations jsonb not null default '[]'::jsonb,
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint material_assignments_page_range check (
    (page_start is null and page_end is null)
    or (page_start >= 1 and page_end >= page_start)
  )
);

create unique index material_assignments_live_unique
  on public.material_assignments (student_id, study_sheet_id, attachment_index)
  where revoked_at is null;

create index material_assignments_student_idx on public.material_assignments (student_id);
create index material_assignments_sheet_idx on public.material_assignments (study_sheet_id);

alter table public.material_assignments enable row level security;

create policy "Teachers read material assignments for own students"
  on public.material_assignments for select to authenticated
  using (exists (
    select 1 from public.trainings t
    where t.student_id = material_assignments.student_id
      and (t.teacher_id = (select auth.uid())
           or t.id in (select get_teacher_training_ids()))
  ));

create policy "Students read own live material assignments"
  on public.material_assignments for select to authenticated
  using (
    revoked_at is null
    and student_id in (
      select s.id from public.students s where s.auth_user_id = (select auth.uid())
    )
  );

create policy "Admins read all material assignments"
  on public.material_assignments for select to authenticated
  using (is_admin());

create policy "Teachers assign material to own students"
  on public.material_assignments for insert to authenticated
  with check (
    assigned_by = (select auth.uid())
    and exists (
      select 1 from public.trainings t
      where t.student_id = material_assignments.student_id
        and (t.teacher_id = (select auth.uid())
             or t.id in (select get_teacher_training_ids()))
    )
    and exists (
      select 1 from public.study_sheets s
      where s.id = material_assignments.study_sheet_id
        and s.is_active = true
        and (
          (exists (select 1 from public.profiles p
                   where p.id = (select auth.uid())
                     and p.account_types @> array['teacher'::text])
           and (s.audience = 'student'::text or s.allowed_roles @> array['teacher'::text])
           and (s.owner_id is null or s.owner_id = (select auth.uid())))
          or
          (exists (select 1 from public.profiles p
                   where p.id = (select auth.uid())
                     and p.account_types @> array['teacher_exam'::text])
           and (s.audience = 'student'::text
                or s.allowed_roles @> array['teacher'::text]
                or s.allowed_roles @> array['teacher_exam'::text])
           and (s.owner_id is null or s.owner_id = (select auth.uid())))
        )
    )
  );

create policy "Students update own homework layer"
  on public.material_assignments for update to authenticated
  using (
    revoked_at is null
    and student_id in (
      select s.id from public.students s where s.auth_user_id = (select auth.uid())
    )
  )
  with check (
    revoked_at is null
    and student_id in (
      select s.id from public.students s where s.auth_user_id = (select auth.uid())
    )
  );

revoke all on public.material_assignments from anon;
revoke all on public.material_assignments from authenticated;
grant select, insert on public.material_assignments to authenticated;
grant update (annotations, updated_at) on public.material_assignments to authenticated;
grant all on public.material_assignments to service_role;