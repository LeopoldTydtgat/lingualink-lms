-- NEW71 Phase 2: ledger writes for reschedule, duration change, and the two
-- recovery RPCs (unwind + refund). Pairs every hours movement in hours_log so
-- the running balance in the ledger always matches trainings.hours_consumed.
-- amount_hours = change in remaining balance (negative = balance down).
-- balance_after = total_hours - hours_consumed after the move.
BEGIN;

-- 1. reschedule_class_atomic: log the NET balance movement (new - old duration).
--    Self-service (student), so created_by = null.
CREATE OR REPLACE FUNCTION public.reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total numeric;
  v_consumed numeric;
  v_net numeric;
  v_rows int;
begin
  select total_hours, hours_consumed
    into v_total, v_consumed
    from trainings
    where id = p_training_id
    for update;

  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  update lessons
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = 'Rescheduled by student',
        updated_at = now()
    where id = p_old_lesson_id
      and student_id = p_student_id
      and status = 'scheduled';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'old_lesson_not_reschedulable' using errcode = 'P0001';
  end if;

  v_net := p_new_duration_hours - p_old_duration_hours;

  if v_consumed + v_net > v_total then
    raise exception 'insufficient_hours' using errcode = 'P0001';
  end if;

  update trainings
    set hours_consumed = hours_consumed + v_net
    where id = p_training_id;

  -- NEW71-P2: net balance movement for the reschedule. 0 when same-length move.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (p_student_id, 'reschedule', -v_net, v_total - (v_consumed + v_net), null);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.reschedule_class_atomic(uuid, uuid, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_class_atomic(uuid, uuid, uuid, numeric, numeric) TO service_role;

-- 2. unwind_reschedule_atomic: write the REVERSING row for the forward reschedule.
--    Goes in the OUTER block (commits with the hours reversal regardless of
--    whether the lesson restore succeeds). created_by = null.
CREATE OR REPLACE FUNCTION public.unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_net_delta numeric;
  v_student_id uuid;
  v_total numeric;
  v_consumed numeric;
  v_rows int;
  v_restored boolean := false;
begin
  v_net_delta := p_new_duration_hours - p_old_duration_hours;

  -- Lock the training row and capture what we need for the reversing ledger row.
  select student_id, total_hours, hours_consumed
    into v_student_id, v_total, v_consumed
    from trainings
    where id = p_training_id
    for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  -- ALWAYS reverse the hours delta the forward reschedule applied (outer block).
  update trainings
    set hours_consumed = hours_consumed - v_net_delta
    where id = p_training_id;

  -- NEW71-P2: reversing row. Cancels the forward 'reschedule' row (net 0), so a
  -- reschedule that fails-then-unwinds leaves no phantom ledger entry.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'reschedule_reversal', v_net_delta, v_total - (v_consumed - v_net_delta), null);

  -- Best-effort restore of the original lesson, guarded sub-block / own savepoint.
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

-- 3. refund_hours_atomic: write a 'booking_reversal' row so the orphaned
--    class_booking from a failed booking is paired. created_by = null.
CREATE OR REPLACE FUNCTION public.refund_hours_atomic(p_training_id uuid, p_hours numeric, p_lesson_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_already_refunded boolean;
  v_new_balance numeric;
  v_total numeric;
  v_student_id uuid;
BEGIN
  IF p_lesson_id IS NOT NULL THEN
    SELECT hours_refunded INTO v_already_refunded
    FROM public.lessons
    WHERE id = p_lesson_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'LESSON_NOT_FOUND');
    END IF;
    IF COALESCE(v_already_refunded, false) THEN
      RETURN jsonb_build_object('success', false, 'code', 'ALREADY_REFUNDED');
    END IF;
  END IF;

  UPDATE public.trainings
     SET hours_consumed = greatest(0, hours_consumed - p_hours)
   WHERE id = p_training_id
   RETURNING hours_consumed, total_hours, student_id
        INTO v_new_balance, v_total, v_student_id;

  IF p_lesson_id IS NOT NULL THEN
    UPDATE public.lessons
       SET hours_refunded = true
     WHERE id = p_lesson_id;
  END IF;

  -- NEW71-P2: reverses the class_booking row written by book_class_atomic before
  -- the failed lesson insert. In the recovery flow consumed-before = p_hours, so
  -- p_hours is the real balance movement.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'booking_reversal', p_hours, v_total - v_new_balance, null);

  RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refund_hours_atomic(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_hours_atomic(uuid, numeric, uuid) TO service_role;

-- 4. change_duration_atomic: NEW signature adds p_created_by (deliberate admin
--    action -> stamp who did it). Drop the old 3-arg version so no unlogged
--    orphan remains callable. created_by = the acting admin's profile id.
DROP FUNCTION IF EXISTS public.change_duration_atomic(uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.change_duration_atomic(p_lesson_id uuid, p_old_duration_minutes integer, p_new_duration_minutes integer, p_created_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_training_id uuid;
  v_lesson_status text;
  v_lesson_duration int;
  v_total numeric;
  v_consumed numeric;
  v_delta_hours numeric;
  v_rows int;
  v_student_id uuid;
begin
  if p_new_duration_minutes not in (30, 60, 90) then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;

  select l.training_id, l.status, l.duration_minutes, t.total_hours, t.hours_consumed, t.student_id
    into v_training_id, v_lesson_status, v_lesson_duration, v_total, v_consumed, v_student_id
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

  update public.lessons
     set duration_minutes = p_new_duration_minutes,
         updated_at = now()
   where id = p_lesson_id
     and status = 'scheduled'
     and duration_minutes = p_old_duration_minutes;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'lesson_already_modified' using errcode = 'P0001';
  end if;

  update public.trainings
     set hours_consumed = hours_consumed + v_delta_hours,
         updated_at = now()
   where id = v_training_id;

  -- NEW71-P2: balance movement for the duration change, stamped with the admin
  -- who made it (deliberate billable mutation).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'duration_change', -v_delta_hours, v_total - (v_consumed + v_delta_hours), p_created_by);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.change_duration_atomic(uuid, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_duration_atomic(uuid, integer, integer, uuid) TO service_role;

COMMIT;