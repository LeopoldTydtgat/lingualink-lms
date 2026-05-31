-- NEW146: unwind_reschedule_atomic recovery rewrite + EXECUTE lockdown.
-- Always reverses the hours delta (outer block, commits unconditionally).
-- Restores the old lesson only if its freed slot is still open; catches the
-- no_teacher_overlap exclusion violation in a guarded sub-block so the hours
-- reversal still commits. Returns true if restored, false if hours returned
-- but the lesson could not be restored. Drop+create (return type changed
-- void -> boolean), so grants are re-applied to match the other 5 hours RPCs.

DROP FUNCTION IF EXISTS public.unwind_reschedule_atomic(uuid, uuid, numeric, numeric);

CREATE FUNCTION public.unwind_reschedule_atomic(
  p_old_lesson_id uuid,
  p_training_id uuid,
  p_old_duration_hours numeric,
  p_new_duration_hours numeric
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
declare
  v_net_delta numeric;
  v_dummy numeric;
  v_rows int;
  v_restored boolean := false;
begin
  v_net_delta := p_new_duration_hours - p_old_duration_hours;

  select hours_consumed into v_dummy
    from trainings
    where id = p_training_id
    for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  -- Always reverse the hours delta. Outer block: commits even if the restore
  -- below fails (the restore runs in a guarded sub-block).
  update trainings
    set hours_consumed = hours_consumed - v_net_delta
    where id = p_training_id;

  -- Best-effort restore. If the freed slot was retaken, flipping back to
  -- scheduled trips no_teacher_overlap (23P01); catch it, leave the lesson
  -- cancelled, report restored = false. Hours stay reversed.
  begin
    update lessons
      set status = 'scheduled',
          cancelled_at = null,
          cancellation_reason = null,
          updated_at = now()
      where id = p_old_lesson_id
        and status = 'cancelled';
    get diagnostics v_rows = row_count;
    v_restored := (v_rows = 1);
  exception
    when exclusion_violation then
      v_restored := false;
  end;

  return v_restored;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.unwind_reschedule_atomic(uuid, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unwind_reschedule_atomic(uuid, uuid, numeric, numeric) TO service_role;