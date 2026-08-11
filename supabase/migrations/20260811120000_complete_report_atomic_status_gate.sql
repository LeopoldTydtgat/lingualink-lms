-- 20260811120000_complete_report_atomic_status_gate.sql
-- Applied live in the Supabase SQL Editor on 11 Aug 2026.
--
-- authenticated holds EXECUTE on this function, so a former or on_hold profile
-- that can still mint a JWT reaches the RPC directly over REST, bypassing the
-- Next app and proxy.ts. The only status check lived in reports/actions.ts, which
-- a direct call never touches. This is a pay path: it flips lessons.status onto a
-- teacher invoice and moves student hours through the NEW346 refund and clawback
-- blocks. The active-account check therefore moves into the database.
--
-- The two-step admin-check-then-owner-check is replaced by a single EXISTS.
-- EXISTS always returns true or false, never NULL, so it cannot fail open the way
-- a bare v_report_teacher <> v_caller comparison would if teacher_id ever loosened
-- from NOT NULL. Nothing else in the body changed.
--
-- EXECUTE deliberately stays with authenticated. Revoking it would force the
-- caller onto the service-role client, where auth.uid() is NULL and the RPC would
-- deny everyone; restoring it would mean passing the caller id as a parameter,
-- replacing a value the database derives itself with one the client supplies.
--
-- Pre-flight before applying: 0 of 13 open reports belonged to a non-current
-- teacher, so no live report was made unfileable by this change.

CREATE OR REPLACE FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lesson_id uuid;
  v_lesson_start timestamptz;
  v_caller uuid := auth.uid();
  v_report_teacher uuid;
  v_authorised boolean;
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

  -- Lesson start time AND the report's owner, in one read.
  SELECT l.scheduled_at,
         r.teacher_id
    INTO v_lesson_start, v_report_teacher
    FROM lessons l
    JOIN reports r ON r.lesson_id = l.id
   WHERE r.id = p_report_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report % not found', p_report_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Active-account gate. authenticated holds EXECUTE on this function, so a
  -- former or on_hold profile that can still mint a JWT reaches this RPC
  -- directly, bypassing the app entirely. The status check therefore cannot
  -- live only in reports/actions.ts: this is a pay path (it flips lessons.status
  -- onto a teacher invoice and moves student hours through the refund and
  -- clawback blocks below), so the database enforces it too.
  --
  -- One EXISTS covering both arms. Written this way deliberately: EXISTS always
  -- returns true or false, never NULL, so it cannot fail open the way a bare
  -- v_report_teacher <> v_caller comparison would if teacher_id were ever NULL.
  SELECT EXISTS (
    SELECT 1
      FROM profiles p
     WHERE p.id = v_caller
       AND p.status = 'current'
       AND (p.role = 'admin' OR p.id = v_report_teacher)
  ) INTO v_authorised;

  IF NOT v_authorised THEN
    RAISE EXCEPTION 'Not authorised'
      USING ERRCODE = 'P0001';
  END IF;

  -- Client rule 8 Aug: the report opens at the class START, not its end. A
  -- teacher waiting on an absent student must be able to file a no-show without
  -- sitting out the full slot, and all three outcomes are available from that
  -- moment. Supersedes the NEW178 Part 2 end-time guard. The start bound stays:
  -- a report can never be filed for a class that has not begun.
  IF v_lesson_start > now() THEN
    RAISE EXCEPTION 'This class has not started yet. You can complete the report once the class has begun.'
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

  -- Widened from <> 'cancelled': the live lessons vocabulary also carries
  -- cancelled_by_student and cancelled_by_teacher. Unreachable today because
  -- cancel_lesson_atomic deletes the report, but the guard now matches the
  -- double-refund guarantee the comment below relies on.
  UPDATE lessons
  SET status     = p_lesson_status,
      updated_at = now()
  WHERE id = v_lesson_id
    AND status NOT IN ('cancelled', 'cancelled_by_student', 'cancelled_by_teacher');

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

  -- NEW346 phase 2 (client rule 2 Aug): student hours follow whether the class
  -- happened. A reopened teacher_no_show report corrected to completed or
  -- student_no_show means the class DID happen, so the earlier refund was
  -- wrong money and is clawed back in the same transaction. Guard on
  -- hours_refunded: a normal first filing never enters this block, and
  -- flipping the flag back to false means a later re-correction to
  -- teacher_no_show refunds correctly again. No clamp on the re-deduct:
  -- a negative balance is truthful and admin-adjustable.
  IF p_lesson_status IN ('completed', 'student_no_show') AND v_rows = 1 THEN
    SELECT l.training_id, l.duration_minutes, l.hours_refunded,
           t.total_hours, t.hours_consumed, t.student_id
      INTO v_training_id, v_duration, v_already_refunded,
           v_total, v_consumed, v_student_id
      FROM public.lessons l
      JOIN public.trainings t ON t.id = l.training_id
     WHERE l.id = v_lesson_id
     FOR UPDATE OF t;

    IF FOUND AND COALESCE(v_already_refunded, false) THEN
      v_hours := v_duration::numeric / 60;
      v_consumed_before := v_consumed;

      UPDATE public.trainings
         SET hours_consumed = hours_consumed + v_hours,
             updated_at     = now()
       WHERE id = v_training_id
       RETURNING hours_consumed INTO v_consumed;

      UPDATE public.lessons
         SET hours_refunded = false
       WHERE id = v_lesson_id;

      -- Actual movement, negative: hours leave the balance.
      INSERT INTO public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id)
      VALUES (v_student_id, 'teacher_no_show_clawback', -(v_consumed - v_consumed_before), v_total - v_consumed, null, v_lesson_id);
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_report_atomic(uuid, text, jsonb) TO service_role;
