-- create_training_atomic: serialised creation of a new training for a student
-- with NO active training. Locks the student row (not trainings - the
-- no-training case has no row to lock), refuses if an active training exists,
-- inserts the trainings row + training_teachers junction rows.
-- Captured from live DB 2026-08-04 (created live S472).

CREATE OR REPLACE FUNCTION public.create_training_atomic(p_student_id uuid, p_package_name text, p_total_hours numeric, p_end_date date, p_teacher_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_training_id uuid;
  v_active_count int;
  v_tid uuid;
begin
  if p_total_hours is null or p_total_hours <= 0 then
    raise exception 'invalid_total_hours' using errcode = 'P0001';
  end if;
  -- Serialisation point: lock the STUDENT row. Two concurrent calls for the
  -- same student queue here, so the active-check below cannot race. Locking
  -- trainings rows would not work - the no-training case has no row to lock.
  perform 1 from public.students where id = p_student_id for update;
  if not found then
    raise exception 'student_not_found' using errcode = 'P0002';
  end if;
  select count(*) into v_active_count
    from public.trainings
   where student_id = p_student_id
     and status = 'active';
  if v_active_count > 0 then
    raise exception 'active_training_exists' using errcode = 'P0001';
  end if;
  insert into public.trainings
    (student_id, package_name, package_type, total_hours, hours_consumed,
     start_date, end_date, status, low_hours_warning_sent, training_ending_soon_sent)
  values
    (p_student_id, p_package_name, p_package_name, p_total_hours, 0,
     current_date, p_end_date, 'active', false, false)
  returning id into v_training_id;
  -- Teacher junction rows. Assignability (role/status) is validated in the API
  -- route exactly as the create-student route does; the FK here is the backstop.
  if p_teacher_ids is not null then
    foreach v_tid in array p_teacher_ids loop
      insert into public.training_teachers (training_id, teacher_id)
      values (v_training_id, v_tid)
      on conflict do nothing;  -- dedupe backstop; route dedupes first
    end loop;
  end if;
  return v_training_id;
end;
$function$;

-- CREATE (OR REPLACE) resets EXECUTE grants - lock down explicitly.
-- Live grants verified 2026-08-04: postgres + service_role only.
REVOKE ALL ON FUNCTION public.create_training_atomic(uuid, text, numeric, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_training_atomic(uuid, text, numeric, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_training_atomic(uuid, text, numeric, date, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_training_atomic(uuid, text, numeric, date, uuid[]) TO service_role;
