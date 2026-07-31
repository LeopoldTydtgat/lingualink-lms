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
  v_rows int;
  v_training_id uuid;
  v_duration int;
  v_already_refunded boolean;
  v_total numeric;
  v_consumed numeric;
  v_consumed_before numeric;
  v_student_id uuid;
  v_hours numeric;
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

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- NEW346: a teacher no-show is not the student's fault, so the hours held at
  -- booking are returned. Same transaction as the report write: if this fails,
  -- the report does not save either. Only runs when the lesson status actually
  -- changed (v_rows = 1); a lesson cancelled underneath us is left alone so this
  -- can never double-refund a lesson cancel_lesson_atomic already settled.
  IF p_lesson_status = 'teacher_no_show' AND v_rows = 1 THEN
    SELECT l.training_id, l.duration_minutes, l.hours_refunded,
           t.total_hours, t.hours_consumed, t.student_id
      INTO v_training_id, v_duration, v_already_refunded,
           v_total, v_consumed, v_student_id
      FROM public.lessons l
      JOIN public.trainings t ON t.id = l.training_id
     WHERE l.id = v_lesson_id
     FOR UPDATE OF t;

    -- NEW142 pattern: COALESCE so a null hours_refunded cannot make this guard
    -- evaluate to null and silently skip the refund.
    IF FOUND AND NOT COALESCE(v_already_refunded, false) THEN
      v_hours := v_duration::numeric / 60;
      v_consumed_before := v_consumed;

      UPDATE public.trainings
         SET hours_consumed = greatest(0, hours_consumed - v_hours),
             updated_at     = now()
       WHERE id = v_training_id
       RETURNING hours_consumed INTO v_consumed;

      UPDATE public.lessons
         SET hours_refunded = true
       WHERE id = v_lesson_id;

      -- NEW263 pattern: amount is the ACTUAL movement, not v_hours, so the
      -- ledger stays truthful if the greatest(0,...) clamp fires.
      INSERT INTO public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
      VALUES (v_student_id, 'teacher_no_show_refund', v_consumed_before - v_consumed, v_total - v_consumed, null, v_lesson_id);
    END IF;
  END IF;
END;
$function$;
