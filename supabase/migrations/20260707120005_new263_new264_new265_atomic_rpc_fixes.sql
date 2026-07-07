-- NEW263 / NEW264 / NEW265 / NEW262(b) catch-up migration: atomic RPC
-- fixes applied live in the Supabase SQL Editor on 07 Jul 2026.
-- Function bodies below are captured verbatim from live
-- pg_get_functiondef reads AFTER the fixes - the live DB is ground truth.
--
-- NEW263 refund_hours_atomic: training row locked FOR UPDATE,
--   TRAINING_NOT_FOUND guard, ledger logs actual movement.
-- NEW264 unwind_reschedule_atomic: greatest(0,...) clamp, ledger logs
--   actual movement, restore also nulls cancelled_by.
-- NEW265 reschedule_class_atomic: stamps cancelled_by='student';
--   teams_join_url deliberately NOT nulled (unwind may restore).
-- NEW262(b) complete_report_atomic: allowlist on p_lesson_status.

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
  -- the failed lesson insert.
  -- NEW257: lesson_id stamped when provided; null in the booking-recovery flow
  -- (the lesson was never created), which is correct.
  -- NEW263: amount is consumed_before - consumed (actual movement, clamp-safe).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'booking_reversal', v_consumed_before - v_new_balance, v_total - v_new_balance, null, p_lesson_id);
  RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
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
  update trainings
    set hours_consumed = greatest(0, hours_consumed - v_net_delta)
    where id = p_training_id
    returning hours_consumed into v_consumed_after;
  -- NEW257: stamped with the old lesson id - this reversal relates to the
  -- original lesson being restored (the failed new lesson was never created).
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
  values (v_student_id, 'reschedule_reversal', v_consumed - v_consumed_after, v_total - v_consumed_after, null, p_old_lesson_id);
  begin
    update lessons
      set status = 'scheduled',
          cancelled_at = null,
          cancellation_reason = null,
          cancelled_by = null,
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
  -- teams_join_url is deliberately NOT nulled here: unwind_reschedule_atomic
  -- may restore this lesson to 'scheduled' and cannot recreate a Teams link.
  -- Nulling the old link after the new lesson exists is the booking route's job.
  update lessons
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = 'Rescheduled by student',
        cancelled_by = 'student',
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

CREATE OR REPLACE FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lesson_id uuid;
  v_lesson_end timestamptz;
  v_caller uuid := auth.uid();
  v_report_teacher uuid;
  v_is_admin boolean;
BEGIN
  -- NEW262: allowlist for caller-supplied lesson status. Report completion can
  -- only produce these three outcomes; cancelled/scheduled/missed are set by
  -- other paths and accepting them here would corrupt billing.
  IF p_lesson_status NOT IN ('completed', 'student_no_show', 'teacher_no_show') THEN
    RAISE EXCEPTION 'Invalid lesson status for report completion: %', p_lesson_status
      USING ERRCODE = 'P0001';
  END IF;
  -- NEW181 auth gate: caller must be the report's teacher or an admin.
  -- Mirrors the app-layer check in reports/actions.ts (submitReport).
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'P0001';
  END IF;
  -- Lesson end time AND the report's owner, in one read.
  SELECT (l.scheduled_at + make_interval(mins => l.duration_minutes)),
         r.teacher_id
    INTO v_lesson_end, v_report_teacher
    FROM lessons l
    JOIN reports r ON r.lesson_id = l.id
   WHERE r.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report % not found', p_report_id
      USING ERRCODE = 'P0002';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_caller AND role = 'admin'
  ) INTO v_is_admin;
  IF NOT v_is_admin AND v_report_teacher <> v_caller THEN
    RAISE EXCEPTION 'Not authorised'
      USING ERRCODE = 'P0001';
  END IF;
  -- NEW178 Part 2 guard: a report may only be completed once its lesson has
  -- actually ENDED. End time, not start time.
  IF v_lesson_end > now() THEN
    RAISE EXCEPTION 'This class has not finished yet. You can complete the report once the class has ended.'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE reports
  SET did_class_happen   = (p_report_payload->>'did_class_happen')::boolean,
      no_show_type       = p_report_payload->>'no_show_type',
      feedback_text      = p_report_payload->>'feedback_text',
      additional_details = p_report_payload->>'additional_details',
      level_data         = p_report_payload->'level_data',
      student_confirmed  = NULLIF(p_report_payload->>'student_confirmed','')::boolean,
      impersonation_note = p_report_payload->>'impersonation_note',
      status             = 'completed',
      completed_at       = now(),
      updated_at         = now()
  WHERE id = p_report_id
    AND status IN ('pending','reopened')
  RETURNING lesson_id INTO v_lesson_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report % is not in pending or reopened state', p_report_id
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE lessons
  SET status     = p_lesson_status,
      updated_at = now()
  WHERE id = v_lesson_id
    AND status <> 'cancelled';
END;
$function$;
