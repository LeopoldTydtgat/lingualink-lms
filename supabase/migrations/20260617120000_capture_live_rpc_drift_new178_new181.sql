-- Migration: capture live RPC drift (NEW178 + NEW181)
-- Date: 2026-06-17
--
-- These four SECURITY DEFINER functions were altered directly in the Supabase
-- SQL editor across session 146 (NEW178: pending-report lifecycle) and session
-- 147 (NEW181: complete_report_atomic auth gate). They were never captured in a
-- repo migration, so the repo was behind the live database. This migration is a
-- VERBATIM capture of the live definitions (pulled via pg_get_functiondef) plus
-- the EXECUTE grants that match the live proacl, so the repo matches production
-- and a from-scratch replay reproduces the current state.
--
-- It is a no-op against the live database: CREATE OR REPLACE of byte-identical
-- bodies, and the grants are already in place. Do not edit the bodies here to
-- "improve" them - they are ground truth as of 2026-06-17. Any future change to
-- one of these functions starts from this file.
--
-- Live grant posture reproduced below:
--   cancel_lesson_atomic       service_role only
--   reschedule_class_atomic    service_role only
--   unwind_reschedule_atomic   service_role only
--   complete_report_atomic     authenticated + service_role
--                              (NEW181: the report form calls it via the
--                              user-session client, so authenticated is kept;
--                              PUBLIC and anon were revoked.)


-- ============================================================
-- cancel_lesson_atomic
-- ============================================================
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

    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
    values (v_student_id, 'cancellation_refund', v_consumed_before - v_consumed, v_total - v_consumed, null);

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

REVOKE EXECUTE ON FUNCTION public.cancel_lesson_atomic(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_lesson_atomic(uuid, text, text, boolean) TO service_role;


-- ============================================================
-- reschedule_class_atomic
-- ============================================================
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
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (p_student_id, 'reschedule', -v_net, v_total - (v_consumed + v_net), null);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.reschedule_class_atomic(uuid, uuid, uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_class_atomic(uuid, uuid, uuid, numeric, numeric) TO service_role;


-- ============================================================
-- unwind_reschedule_atomic
-- ============================================================
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

  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'reschedule_reversal', v_net_delta, v_total - (v_consumed - v_net_delta), null);

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

REVOKE EXECUTE ON FUNCTION public.unwind_reschedule_atomic(uuid, uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unwind_reschedule_atomic(uuid, uuid, numeric, numeric) TO service_role;


-- ============================================================
-- complete_report_atomic   (NEW181 auth gate)
-- ============================================================
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

REVOKE EXECUTE ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) TO service_role;
