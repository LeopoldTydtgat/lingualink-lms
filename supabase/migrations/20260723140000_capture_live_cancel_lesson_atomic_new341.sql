-- Migration: capture live cancel_lesson_atomic drift (NEW341)
-- Date: 2026-07-23
--
-- cancel_lesson_atomic was altered directly in the Supabase SQL editor (NEW341)
-- to null rescheduled_by / rescheduled_at on every cancellation. That edit was
-- never captured in a repo migration, so the repo lagged the live database.
--
-- Why it matters now: billing consumes rescheduled_by (getBillability zeroes
-- reschedule legs and reads the rescheduled_by actor). An admin in-place time
-- edit stamps rescheduled_by / rescheduled_at on a row that stays 'scheduled'.
-- If that row is later truly cancelled, the stale stamp would drive both the
-- cancellation label and the billability decision. The live function drops the
-- stamp on cancellation; a from-scratch DB built only from migrations would
-- resurrect the stale-reschedule-stamp bug without this capture.
--
-- This migration is a VERBATIM capture of the live definition (body read from
-- the live database 23 Jul 2026) plus the EXECUTE grants that match the live
-- proacl, so the repo matches production and a from-scratch replay reproduces
-- the current state.
--
-- It is a no-op against the live database: CREATE OR REPLACE of a byte-identical
-- body, and the grant is already in place. Do not edit the body here to
-- "improve" it - it is ground truth as of 2026-07-23. Any future change to this
-- function starts from this file.
--
-- Live grant posture reproduced below:
--   cancel_lesson_atomic       service_role only


-- ============================================================
-- cancel_lesson_atomic   (NEW341 rescheduled_by clearing)
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
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
begin
  if p_cancelled_by not in ('student', 'teacher', 'admin') then
    return jsonb_build_object('success', false, 'code', 'INVALID_ACTOR');
  end if;
  v_new_status := case p_cancelled_by
    when 'student' then 'cancelled_by_student'
    when 'teacher' then 'cancelled_by_teacher'
    when 'admin'   then 'cancelled'
  end;
  select l.training_id, l.status, l.duration_minutes, l.hours_refunded,
         t.total_hours, t.hours_consumed, t.student_id
    into v_training_id, v_status, v_duration, v_already_refunded,
         v_total, v_consumed, v_student_id
    from public.lessons l
    join public.trainings t on t.id = l.training_id
   where l.id = p_lesson_id
   for update of t;
  if not found then
    return jsonb_build_object('success', false, 'code', 'LESSON_NOT_FOUND');
  end if;
  if v_status is distinct from 'scheduled' then
    return jsonb_build_object(
      'success', false, 'code', 'LESSON_NOT_CANCELLABLE', 'current_status', v_status
    );
  end if;
  -- NEW341: clear rescheduled_by/rescheduled_at. An admin in-place time edit
  -- stamps these on a row that stays 'scheduled'. If that row is later truly
  -- cancelled, getCancellationLabel consults rescheduled_by BEFORE it resolves
  -- the cancellation actor and would render "Rescheduled by admin" for a class
  -- the student cancelled. An outright cancellation supersedes the earlier move,
  -- so the stamp is dropped and cancelled_by alone drives the label.
  update public.lessons
     set status              = v_new_status,
         cancelled_at        = now(),
         cancellation_reason = p_cancellation_reason,
         cancelled_by        = p_cancelled_by,
         rescheduled_by      = null,
         rescheduled_at      = null,
         teams_join_url      = null,
         updated_at          = now()
   where id = p_lesson_id
     and status = 'scheduled';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('success', false, 'code', 'LESSON_NOT_CANCELLABLE');
  end if;
  -- NEW178: drop the now-irrelevant report for this cancelled lesson.
  -- Includes 'flagged': the overdue cron may have flipped it before cancel.
  delete from public.reports
   where lesson_id = p_lesson_id
     and status in ('pending','reopened','flagged');
  -- NEW142: COALESCE so a null hours_refunded cannot make this guard evaluate
  -- to null and silently skip the refund (three-valued-logic bug).
  if p_should_refund and not coalesce(v_already_refunded, false) then
    v_hours := v_duration::numeric / 60;
    v_consumed_before := v_consumed;
    update public.trainings
       set hours_consumed = greatest(0, hours_consumed - v_hours),
           updated_at     = now()
     where id = v_training_id
     returning hours_consumed into v_consumed;
    update public.lessons
       set hours_refunded = true
     where id = p_lesson_id;
    -- NEW257: stamp the lesson on the ledger row
    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
    values (v_student_id, 'cancellation_refund', v_consumed_before - v_consumed, v_total - v_consumed, null, p_lesson_id);
    v_refunded := true;
  end if;
  return jsonb_build_object(
    'success',         true,
    'status',          v_new_status,
    'refunded',        v_refunded,
    'remaining_hours', greatest(0, v_total - v_consumed)
  );
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.cancel_lesson_atomic(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_lesson_atomic(uuid, text, text, boolean) TO service_role;
