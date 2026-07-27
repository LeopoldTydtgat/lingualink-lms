-- Captured from live DDL run 27 Jul 2026 (Supabase SQL Editor).
-- 1. Dropped legacy classes table: zero code references, zero views/functions/
--    triggers depending on it (verified live), 3 seed rows deleted first.
--    Its RESTRICT FKs (classes_student_id_fkey, classes_teacher_id_fkey) were
--    silent hard-blockers on student/teacher purges.
-- 2. Created purge_student_atomic: replaces the 12-statement unchecked purge
--    cascade in api/admin/students/[id]/route.ts DELETE. All preflights
--    fail-closed, single transaction, students delete asserts row_count = 1.
--    Auth user deletion remains in the route (cannot join a SQL transaction).

delete from public.classes;
drop table public.classes;

create or replace function public.purge_student_atomic(p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_student record;
  v_blocking_teachers text[];
  v_owned_sheets int;
  v_profile_blockers jsonb := '[]'::jsonb;
  v_cnt int;
  v_deleted jsonb := '{}'::jsonb;
  v_rows int;
begin
  -- Preflight 1: student exists, lock the row
  select id, full_name, status, auth_user_id
    into v_student
    from public.students
   where id = p_student_id
   for update;
  if not found then
    raise exception 'student_not_found' using errcode = 'P0002';
  end if;

  -- Preflight 2: must be archived
  if v_student.status is distinct from 'former' then
    raise exception 'student_not_former' using errcode = 'P0001';
  end if;

  -- Preflight 3: all lesson-linked teachers must be former
  select array_agg(distinct p.full_name)
    into v_blocking_teachers
    from public.lessons l
    join public.profiles p on p.id = l.teacher_id
   where l.student_id = p_student_id
     and l.teacher_id is not null
     and p.status is distinct from 'former';
  if v_blocking_teachers is not null then
    raise exception 'teachers_not_former: %', array_to_string(v_blocking_teachers, ', ')
      using errcode = 'P0001';
  end if;

  -- Preflight 4: dual-identity guards
  if v_student.auth_user_id is not null
     and exists (select 1 from public.profiles where id = v_student.auth_user_id) then

    select count(*) into v_owned_sheets
      from public.study_sheets where owner_id = v_student.auth_user_id;
    if v_owned_sheets > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'study_sheets', 'count', v_owned_sheets));
    end if;

    select count(*) into v_cnt from public.invoices where teacher_id = v_student.auth_user_id;
    if v_cnt > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'invoices', 'count', v_cnt));
    end if;

    select count(*) into v_cnt from public.lessons where teacher_id = v_student.auth_user_id;
    if v_cnt > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'lessons(as teacher)', 'count', v_cnt));
    end if;

    select count(*) into v_cnt from public.reports where teacher_id = v_student.auth_user_id;
    if v_cnt > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'reports(as teacher)', 'count', v_cnt));
    end if;

    select count(*) into v_cnt from public.trainings where teacher_id = v_student.auth_user_id;
    if v_cnt > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'trainings(as teacher)', 'count', v_cnt));
    end if;

    select count(*) into v_cnt from public.teacher_history_log where teacher_id = v_student.auth_user_id;
    if v_cnt > 0 then
      v_profile_blockers := v_profile_blockers
        || jsonb_build_array(jsonb_build_object('table', 'teacher_history_log', 'count', v_cnt));
    end if;

    if jsonb_array_length(v_profile_blockers) > 0 then
      raise exception 'dual_identity_blocked: %', v_profile_blockers::text
        using errcode = 'P0001';
    end if;
  end if;

  -- Deletes

  delete from public.messages
   where sender_id = p_student_id or receiver_id = p_student_id;
  get diagnostics v_rows = row_count;
  v_deleted := v_deleted || jsonb_build_object('messages', v_rows);

  delete from public.support_messages
   where participant_id = p_student_id::text
      or (v_student.auth_user_id is not null
          and participant_auth_id = v_student.auth_user_id);
  get diagnostics v_rows = row_count;
  v_deleted := v_deleted || jsonb_build_object('support_messages', v_rows);

  delete from public.lessons where student_id = p_student_id;
  get diagnostics v_rows = row_count;
  v_deleted := v_deleted || jsonb_build_object('lessons', v_rows);

  delete from public.students where id = p_student_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'students_delete_failed' using errcode = 'P0001';
  end if;
  v_deleted := v_deleted || jsonb_build_object('students', v_rows);

  if v_student.auth_user_id is not null then
    delete from public.profiles where id = v_student.auth_user_id;
    get diagnostics v_rows = row_count;
    v_deleted := v_deleted || jsonb_build_object('profiles', v_rows);
  end if;

  return jsonb_build_object(
    'success', true,
    'auth_user_id', v_student.auth_user_id,
    'deleted', v_deleted
  );
end;
$function$;

revoke all on function public.purge_student_atomic(uuid) from public, anon, authenticated;
grant execute on function public.purge_student_atomic(uuid) to service_role;
