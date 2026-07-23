-- Applied manually in the Supabase SQL Editor on 23 Jul 2026; this file is the repo record.
--
-- admin_edit_lesson_atomic replaces change_duration_atomic (dropped at the bottom).
-- The admin PATCH edit branch previously ran change_duration_atomic (its own
-- transaction) followed by a separate lessons UPDATE for scheduled_at / teacher_id /
-- reminder flags / reschedule stamps; that second write could fail (e.g.
-- exclusion-constraint 23P01) after hours had already moved. This function owns ALL
-- lesson field writes plus the hours_consumed / hours_log movement in one transaction.

CREATE OR REPLACE FUNCTION public.admin_edit_lesson_atomic(
  p_lesson_id uuid,
  p_old_duration_minutes integer,
  p_new_duration_minutes integer,
  p_created_by uuid,
  p_new_scheduled_at timestamptz DEFAULT NULL,
  p_new_teacher_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_training_id uuid;
  v_lesson_status text;
  v_lesson_duration int;
  v_scheduled_at timestamptz;
  v_total numeric;
  v_consumed numeric;
  v_delta_hours numeric;
  v_rows int;
  v_student_id uuid;
  v_time_changed boolean;
begin
  if p_new_duration_minutes not in (30, 60, 90) then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;
  select l.training_id, l.status, l.duration_minutes, l.scheduled_at,
         t.total_hours, t.hours_consumed, t.student_id
    into v_training_id, v_lesson_status, v_lesson_duration, v_scheduled_at,
         v_total, v_consumed, v_student_id
    from public.lessons l
    join public.trainings t on t.id = l.training_id
   where l.id = p_lesson_id
   for update of t;
  if not found then
    raise exception 'lesson_not_found' using errcode = 'P0002';
  end if;
  if v_lesson_status is distinct from 'scheduled' then
    raise exception 'lesson_not_editable' using errcode = 'P0001';
  end if;
  if v_lesson_duration is distinct from p_old_duration_minutes then
    raise exception 'lesson_already_modified' using errcode = 'P0001';
  end if;
  v_delta_hours := (p_new_duration_minutes - p_old_duration_minutes)::numeric / 60;
  if v_delta_hours > 0 and (v_total - v_consumed) < v_delta_hours then
    raise exception 'insufficient_hours' using errcode = 'P0001';
  end if;
  -- Reminder resets and reschedule stamps fire only when the class time actually
  -- moved (NEW341 semantics preserved). Teacher-only and duration-only edits do
  -- not reset reminders or stamp a reschedule.
  v_time_changed := p_new_scheduled_at is not null
                    and p_new_scheduled_at is distinct from v_scheduled_at;
  update public.lessons
     set duration_minutes = p_new_duration_minutes,
         scheduled_at     = coalesce(p_new_scheduled_at, scheduled_at),
         teacher_id       = coalesce(p_new_teacher_id, teacher_id),
         reminder_24_sent = case when v_time_changed then false else reminder_24_sent end,
         reminder_1h_sent = case when v_time_changed then false else reminder_1h_sent end,
         rescheduled_by   = case when v_time_changed then 'admin' else rescheduled_by end,
         rescheduled_at   = case when v_time_changed then now() else rescheduled_at end,
         updated_at       = now()
   where id = p_lesson_id
     and status = 'scheduled'
     and duration_minutes = p_old_duration_minutes;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'lesson_already_modified' using errcode = 'P0001';
  end if;
  -- Hours + ledger only when the duration actually changed. A time-only or
  -- teacher-only edit writes no balance movement and no hours_log row.
  if v_delta_hours <> 0 then
    update public.trainings
       set hours_consumed = hours_consumed + v_delta_hours,
           updated_at = now()
     where id = v_training_id;
    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
    values (v_student_id, 'duration_change', -v_delta_hours, v_total - (v_consumed + v_delta_hours), p_created_by, p_lesson_id);
  end if;
end;
$function$;

-- CREATE resets EXECUTE grants -- re-lock immediately after the CREATE.
-- Only the service-role admin client may call this.
REVOKE ALL ON FUNCTION public.admin_edit_lesson_atomic(uuid, integer, integer, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_edit_lesson_atomic(uuid, integer, integer, uuid, timestamptz, uuid) TO service_role;

-- Superseded by admin_edit_lesson_atomic; already dropped from the live DB.
DROP FUNCTION IF EXISTS public.change_duration_atomic(uuid, integer, integer, uuid);
