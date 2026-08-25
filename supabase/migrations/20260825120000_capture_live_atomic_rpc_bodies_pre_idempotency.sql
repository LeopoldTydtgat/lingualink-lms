-- Captures the LIVE bodies of the four money-path RPCs as they stood on
-- 25 Aug 2026, read out of pg_get_functiondef in the SQL Editor. No behaviour
-- change: this file is a baseline snapshot only.
--
-- Why it exists: 20260805090000_s476_rpc_updated_at_stamps.sql recorded that all
-- four functions were changed live on 5 Aug 2026 but contained no SQL, so the
-- repo has not held a current body for any of them since that date. The
-- idempotency-key work that follows edits book_class_atomic and
-- reschedule_class_atomic, and must not do so on top of an unrecorded baseline.
--
-- Grants at capture time were {postgres=X/postgres,service_role=X/postgres} on
-- all four. CREATE OR REPLACE does not reset EXECUTE grants, so none are
-- re-issued here. Only DROP FUNCTION resets them.

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
  -- S476: stamp updated_at. The student What's New hours-low item keys its
  -- seen-tracking on trainings.updated_at; a booking that drops the balance
  -- under 2h must move the stamp or the warning is born pre-seen.
  update public.trainings
     set hours_consumed = v_new_consumed,
         updated_at = now()
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
  v_consumed_before numeric;
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
  -- NEW263: lock the training and capture consumed-before so the ledger row
  -- records the ACTUAL movement, not p_hours (which is wrong if the
  -- greatest(0,...) clamp fires). Same pattern as cancel_lesson_atomic.
  SELECT hours_consumed INTO v_consumed_before
    FROM public.trainings
   WHERE id = p_training_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'TRAINING_NOT_FOUND');
  END IF;
  -- S476: stamp updated_at (What's New seen-tracking keys on it).
  UPDATE public.trainings
     SET hours_consumed = greatest(0, hours_consumed - p_hours),
         updated_at = now()
   WHERE id = p_training_id
   RETURNING hours_consumed, total_hours, student_id
        INTO v_new_balance, v_total, v_student_id;
  IF p_lesson_id IS NOT NULL THEN
    UPDATE public.lessons
       SET hours_refunded = true
     WHERE id = p_lesson_id;
  END IF;
  -- NEW71-P2: reverses the class_booking row written by book_class_atomic before
  -- the failed lesson insert.
  -- NEW257: lesson_id stamped when provided; null in the booking-recovery flow
  -- (the lesson was never created), which is correct.
  -- NEW263: amount is consumed_before - consumed (actual movement, clamp-safe).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'booking_reversal', v_consumed_before - v_new_balance, v_total - v_new_balance, null, p_lesson_id);
  RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
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
  -- NEW265: stamp cancelled_by, aligning with cancel_lesson_atomic.
  -- NEW341: also stamp rescheduled_by/rescheduled_at. cancelled_by stays the
  -- ACTOR ('student'); rescheduled_by answers the separate question of who moved
  -- the lesson off this slot, so a reschedule leg is distinguishable from a real
  -- student cancel without destroying actor attribution.
  -- teams_join_url is deliberately NOT nulled here: unwind_reschedule_atomic
  -- may restore this lesson to 'scheduled' and cannot recreate a Teams link.
  -- Nulling the old link after the new lesson exists is the booking route's job.
  update lessons
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = 'Rescheduled by student',
        cancelled_by = 'student',
        rescheduled_by = 'student',
        rescheduled_at = now(),
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
  -- S476: stamp updated_at (What's New seen-tracking keys on it).
  update trainings
    set hours_consumed = hours_consumed + v_net,
        updated_at = now()
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
  v_consumed_after numeric;
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
  -- NEW264: clamp so hours_consumed cannot go negative, and log the ACTUAL
  -- movement (consumed-before minus consumed-after), not v_net_delta.
  -- The reversal deliberately stands even if the old-lesson restore below
  -- fails: it reverses the forward hours change for a new lesson that was
  -- never created, which is correct in every outcome. Restore failure is
  -- signalled by the false return.
  -- S476: stamp updated_at (What's New seen-tracking keys on it).
  update trainings
    set hours_consumed = greatest(0, hours_consumed - v_net_delta),
        updated_at = now()
    where id = p_training_id
    returning hours_consumed into v_consumed_after;
  -- NEW257: stamped with the old lesson id - this reversal relates to the
  -- original lesson being restored (the failed new lesson was never created).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'reschedule_reversal', v_consumed - v_consumed_after, v_total - v_consumed_after, null, p_old_lesson_id);
  begin
    -- NEW341: clear rescheduled_by/rescheduled_at on restore. reschedule_class_atomic
    -- stamped them on the forward path; if the new booking failed, this lesson goes
    -- back to being a live scheduled class that was never moved. Leaving the stamp
    -- would make a later cancellation of this same row render as "Rescheduled by
    -- student" instead of the true cancellation actor.
    update lessons
      set status = 'scheduled',
          cancelled_at = null,
          cancellation_reason = null,
          cancelled_by = null,
          rescheduled_by = null,
          rescheduled_at = null,
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
