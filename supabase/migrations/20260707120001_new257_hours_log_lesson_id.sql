-- NEW257 - add lesson_id to hours_log ledger, applied live via Supabase SQL
-- Editor 07 Jul 2026, this file is the repo catch-up record.

-- SET NULL so the student-purge delete cascade in admin/students/[id]/route.ts
-- is not blocked.
ALTER TABLE public.hours_log ADD COLUMN lesson_id uuid
  REFERENCES public.lessons(id) ON DELETE SET NULL;

-- return type change (void -> uuid) requires drop+recreate.
DROP FUNCTION public.book_class_atomic(uuid, numeric);

CREATE OR REPLACE FUNCTION public.book_class_atomic(p_training_id uuid, p_hours_needed numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total numeric;
  v_consumed numeric;
  v_status text;
  v_student_id uuid;
  v_new_consumed numeric;
  v_log_id uuid;
begin
  -- NEW71 hardening: reject non-positive hours. Without this, a negative value
  -- passes the balance guard below and self-grants hours via the ledger insert.
  if p_hours_needed is null or p_hours_needed <= 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;
  select total_hours, hours_consumed, status, student_id
    into v_total, v_consumed, v_status, v_student_id
    from public.trainings
   where id = p_training_id
   for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0002';
  end if;
  if v_status is distinct from 'active' then
    raise exception 'training_not_active' using errcode = 'P0001';
  end if;
  if (v_total - v_consumed) < p_hours_needed then
    raise exception 'insufficient_hours' using errcode = 'P0001';
  end if;
  v_new_consumed := v_consumed + p_hours_needed;
  update public.trainings
     set hours_consumed = v_new_consumed
   where id = p_training_id;
  -- NEW71: ledger row for the balance movement. amount is negative (booking
  -- reduces balance); created_by null = automatic/self-service booking.
  -- NEW257: lesson_id is null here because the lesson row does not exist yet -
  -- it is inserted by the booking route AFTER this RPC succeeds. The route
  -- backfills lesson_id using the returned hours_log id.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'class_booking', -p_hours_needed, v_total - v_new_consumed, null)
  returning id into v_log_id;
  return v_log_id;
end;
$function$;

-- DROP+CREATE resets grants to default (anon/authenticated EXECUTE); this was
-- revoked live immediately after recreation.
REVOKE EXECUTE ON FUNCTION public.book_class_atomic(uuid, numeric) FROM anon, authenticated, public;
-- Documents the verified live end state (post-REVOKE grants query showed exactly
-- postgres + service_role with EXECUTE; service_role retained it via Supabase
-- default privileges). Explicit here so a from-scratch rebuild is also safe.
GRANT EXECUTE ON FUNCTION public.book_class_atomic(uuid, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_training_id     uuid;
  v_status          text;
  v_duration        int;
  v_already_refunded boolean;
  v_total           numeric;
  v_consumed        numeric;
  v_hours           numeric;
  v_new_status      text;
  v_refunded        boolean := false;
  v_rows            int;
  v_student_id      uuid;
  v_consumed_before numeric;
BEGIN
  IF p_cancelled_by NOT IN ('student', 'teacher', 'admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ACTOR');
  END IF;
  v_new_status := CASE p_cancelled_by
    WHEN 'student' THEN 'cancelled_by_student'
    WHEN 'teacher' THEN 'cancelled_by_teacher'
    WHEN 'admin'   THEN 'cancelled'
  END;
  SELECT l.training_id, l.status, l.duration_minutes, l.hours_refunded,
         t.total_hours, t.hours_consumed, t.student_id
    INTO v_training_id, v_status, v_duration, v_already_refunded,
         v_total, v_consumed, v_student_id
    FROM public.lessons l
    JOIN public.trainings t ON t.id = l.training_id
   WHERE l.id = p_lesson_id
   FOR UPDATE OF t;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'LESSON_NOT_FOUND');
  END IF;
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'LESSON_NOT_CANCELLABLE', 'current_status', v_status
    );
  END IF;
  UPDATE public.lessons
     SET status              = v_new_status,
         cancelled_at        = now(),
         cancellation_reason = p_cancellation_reason,
         cancelled_by        = p_cancelled_by,
         teams_join_url      = null,
         updated_at          = now()
   WHERE id = p_lesson_id
     AND status = 'scheduled';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'LESSON_NOT_CANCELLABLE');
  END IF;
  -- NEW178: drop the now-irrelevant report for this cancelled lesson.
  -- Includes 'flagged': the overdue cron may have flipped it before cancel.
  DELETE FROM public.reports
   WHERE lesson_id = p_lesson_id
     AND status IN ('pending','reopened','flagged');
  -- NEW142: COALESCE so a null hours_refunded cannot make this guard evaluate
  -- to null and silently skip the refund (three-valued-logic bug).
  IF p_should_refund AND NOT COALESCE(v_already_refunded, false) THEN
    v_hours := v_duration::numeric / 60;
    v_consumed_before := v_consumed;
    UPDATE public.trainings
       SET hours_consumed = greatest(0, hours_consumed - v_hours),
           updated_at     = now()
     WHERE id = v_training_id
     RETURNING hours_consumed INTO v_consumed;
    UPDATE public.lessons
       SET hours_refunded = true
     WHERE id = p_lesson_id;
    -- NEW257: stamp the lesson on the ledger row
    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
    values (v_student_id, 'cancellation_refund', v_consumed_before - v_consumed, v_total - v_consumed, null, p_lesson_id);
    v_refunded := true;
  END IF;
  RETURN jsonb_build_object(
    'success',         true,
    'status',          v_new_status,
    'refunded',        v_refunded,
    'remaining_hours', greatest(0, v_total - v_consumed)
  );
END;
$function$;

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

  -- NEW178: drop the report on the old (now cancelled) lesson. The new lesson
  -- created by the booking route gets its own pending report. Includes
  -- 'flagged' for the same reason as cancel_lesson_atomic.
  delete from public.reports
   where lesson_id = p_old_lesson_id
     and status in ('pending','reopened','flagged');

  v_net := p_new_duration_hours - p_old_duration_hours;

  if v_consumed + v_net > v_total then
    raise exception 'insufficient_hours' using errcode = 'P0001';
  end if;

  update trainings
    set hours_consumed = hours_consumed + v_net
    where id = p_training_id;

  -- NEW71-P2: net balance movement for the reschedule. 0 when same-length move.
  -- NEW257: stamped with the OLD lesson id by design - the new lesson does not
  -- exist inside this RPC; it is created afterwards by the booking route.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (p_student_id, 'reschedule', -v_net, v_total - (v_consumed + v_net), null, p_old_lesson_id);
end;
$function$;

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

  select student_id, total_hours, hours_consumed
    into v_student_id, v_total, v_consumed
    from trainings
    where id = p_training_id
    for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  update trainings
    set hours_consumed = hours_consumed - v_net_delta
    where id = p_training_id;

  -- NEW257: stamped with the old lesson id - this reversal relates to the
  -- original lesson being restored (the failed new lesson was never created).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'reschedule_reversal', v_net_delta, v_total - (v_consumed - v_net_delta), null, p_old_lesson_id);

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

    -- NEW178: if the original lesson is restored to 'scheduled', recreate its
    -- pending report (reschedule_class_atomic deleted it on the forward path).
    -- ON CONFLICT (lesson_id) DO NOTHING so a surviving report is not duplicated.
    -- deadline_at = lesson end + 12h, matching the booking-time helper.
    if v_restored then
      insert into public.reports (lesson_id, teacher_id, status, deadline_at)
      select l.id, l.teacher_id, 'pending',
             l.scheduled_at + make_interval(mins => l.duration_minutes) + interval '12 hours'
        from lessons l
        where l.id = p_old_lesson_id
      on conflict (lesson_id) do nothing;
    end if;
  exception
    when exclusion_violation then
      v_restored := false;
  end;

  return v_restored;
end;
$function$;

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
  -- NEW257: lesson_id stamped when provided; null in the booking-recovery flow
  -- (the lesson was never created), which is correct.
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'booking_reversal', p_hours, v_total - v_new_balance, null, p_lesson_id);

  RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$function$;

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
  -- NEW257: stamp the lesson on the ledger row
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'duration_change', -v_delta_hours, v_total - (v_consumed + v_delta_hours), p_created_by, p_lesson_id);
end;
$function$;
