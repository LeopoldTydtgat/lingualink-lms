-- Record of DDL ALREADY EXECUTED live via the Supabase SQL Editor on 31 Jul 2026.
-- This file is the repo capture of that session so a from-scratch replay
-- reproduces the live state. Statements are ordered as executed.

-- Block 1: hazard sweep. Strip TRUNCATE/TRIGGER/REFERENCES from authenticated
-- on tables where those grants were never intentional (no app code path uses
-- them; TRUNCATE in particular bypasses RLS-scoped DELETE and can wipe a
-- table wholesale). REVOKE is idempotent: safe to re-run even if already revoked.
revoke truncate, trigger, references on public.announcements from authenticated;
revoke truncate, trigger, references on public.assignments from authenticated;
revoke truncate, trigger, references on public.student_reviews from authenticated;
revoke truncate, trigger, references on public.study_sheets from authenticated;

-- Block 2: announcements grant tightening. Writes go through admin-only
-- server routes using the service-role client; authenticated has no
-- legitimate direct-write path.
revoke insert, update, delete on public.announcements from authenticated;

-- Block 3: student_reviews grant tightening. Student INSERT stays (RLS-bound
-- self-service review submission); no authenticated update/delete path exists.
revoke update, delete on public.student_reviews from authenticated;

-- Block 4: assignments grant tightening. Same rationale as Block 3.
revoke update, delete on public.assignments from authenticated;

-- Block 5 (NEW374): tighten the assignments insert policy so a teacher can
-- only assign study sheets that are active, student-audience, admin-library
-- resources (owner_id is null), closing the gap where a teacher could assign
-- an inactive or staff-only sheet.
alter policy "Teachers can insert assignments" on public.assignments
  with check (
    assigned_by = (select auth.uid())
    and exists (
      select 1 from public.study_sheets ss
      where ss.id = assignments.study_sheet_id
        and ss.is_active = true
        and ss.audience = 'student'
        and ss.owner_id is null
    )
  );

-- Block 6 (NEW381): widen the assignments select policy so a substitute
-- teacher covering a training via get_teacher_training_ids() can view
-- assignments for that training's students, not only the primary teacher.
alter policy "Teachers can view assignments" on public.assignments
  using (
    exists (
      select 1 from public.trainings t
      where t.student_id = assignments.student_id
        and (
          t.teacher_id = (select auth.uid())
          or t.id in (select get_teacher_training_ids())
        )
    )
  );

-- Block 7 (NEW366): document that study_sheets.owner_id is an authorisation
-- pointer only in combination with the write policies EXISTS checks; the FK
-- alone does not prove the referenced profile is staff (it also accepts
-- students), so it must never be treated as an authorisation mechanism.
comment on column public.study_sheets.owner_id is
  'NULL = admin library resource visible per audience/role tiers. Non-null = teacher-owned private material. The EXISTS checks in the write policies do the authorisation work (account_types + status); the FK to profiles(id) only guarantees the uuid references a profile row, which includes students - it does NOT prove staff. Do not treat this FK as an authorisation mechanism.';

-- Block 8 (NEW367): swap study_sheets.owner_id FK from ON DELETE CASCADE to
-- ON DELETE RESTRICT so deleting a profile that still owns study sheets fails
-- loudly instead of silently cascading the deletion into teacher-authored
-- material. Guarded: only runs if the live constraint is not already RESTRICT
-- (confdeltype <> 'r'), so replaying this file is a no-op after the first run.
do $$
declare
  v_confdeltype char;
begin
  select confdeltype into v_confdeltype
  from pg_constraint
  where conrelid = 'public.study_sheets'::regclass
    and conname = 'study_sheets_owner_id_fkey';

  if v_confdeltype is distinct from 'r' then
    alter table public.study_sheets
      drop constraint study_sheets_owner_id_fkey;

    alter table public.study_sheets
      add constraint study_sheets_owner_id_fkey
      foreign key (owner_id) references public.profiles(id) on delete restrict;
  end if;
end
$$;
