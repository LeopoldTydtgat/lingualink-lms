-- cancel_lesson_atomic: single-transaction lesson cancellation.
-- Flips status, nulls teams_join_url, and conditionally refunds hours atomically.
-- Deliberately does NOT touch teams_meeting_id — the caller tears down the Teams
-- meeting AFTER this commits, so a Graph failure can never destroy a meeting for a
-- still-scheduled lesson. Applied manually via Supabase SQL editor; archived here.
CREATE OR REPLACE FUNCTION public.cancel_lesson_atomic(
  p_lesson_id uuid,
  p_cancelled_by text,
  p_cancellation_reason text,
  p_should_refund boolean
)
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
         t.total_hours, t.hours_consumed
    INTO v_training_id, v_status, v_duration, v_already_refunded,
         v_total, v_consumed
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

  IF p_should_refund AND NOT v_already_refunded THEN
    v_hours := v_duration::numeric / 60;

    UPDATE public.trainings
       SET hours_consumed = greatest(0, hours_consumed - v_hours),
           updated_at     = now()
     WHERE id = v_training_id
     RETURNING hours_consumed INTO v_consumed;

    UPDATE public.lessons
       SET hours_refunded = true
     WHERE id = p_lesson_id;

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
