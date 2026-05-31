--
-- PostgreSQL database dump
--

\restrict RYEhJ9at17abHBbZ5P4Y6imVkHVL9smkccbrxLv1LTG1bozwyVUJ3maG4M6gpkd

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: book_class_atomic(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.book_class_atomic(p_training_id uuid, p_hours_needed numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_total numeric;
  v_consumed numeric;
  v_status text;
  v_student_id uuid;
  v_new_consumed numeric;
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
  insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by)
  values (v_student_id, 'class_booking', -p_hours_needed, v_total - v_new_consumed, null);
end;
$$;


--
-- Name: cancel_lesson_atomic(uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: change_duration_atomic(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_duration_atomic(p_lesson_id uuid, p_old_duration_minutes integer, p_new_duration_minutes integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_training_id uuid;
  v_lesson_status text;
  v_lesson_duration int;
  v_total numeric;
  v_consumed numeric;
  v_delta_hours numeric;
  v_rows int;
begin
  if p_new_duration_minutes not in (30, 60, 90) then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;

  select l.training_id, l.status, l.duration_minutes, t.total_hours, t.hours_consumed
    into v_training_id, v_lesson_status, v_lesson_duration, v_total, v_consumed
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
end;
$$;


--
-- Name: complete_report_atomic(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_lesson_id uuid;
BEGIN
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
$$;


--
-- Name: flag_overdue_reports(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flag_overdue_reports() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.reports
  SET
    status = 'flagged',
    flagged_at = NOW(),
    updated_at = NOW()
  WHERE
    status = 'pending'
    AND deadline_at IS NOT NULL
    AND deadline_at < NOW();
END;
$$;


--
-- Name: get_current_student_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_current_student_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT id FROM students WHERE auth_user_id = auth.uid() LIMIT 1;
$$;


--
-- Name: get_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  select role from public.profiles where id = auth.uid();
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND (
      role = 'admin'
      OR 'school_admin' = ANY(account_types)
    )
  );
$$;


--
-- Name: lesson_end_time(timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lesson_end_time(starts_at timestamp with time zone, duration_minutes integer) RETURNS timestamp with time zone
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT starts_at + (duration_minutes * interval '1 minute')
$$;


--
-- Name: refund_hours_atomic(uuid, numeric, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_hours_atomic(p_training_id uuid, p_hours numeric, p_lesson_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_already_refunded boolean;
  v_new_balance numeric;
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
   RETURNING hours_consumed INTO v_new_balance;
  IF p_lesson_id IS NOT NULL THEN
    UPDATE public.lessons
       SET hours_refunded = true
     WHERE id = p_lesson_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$$;


--
-- Name: reschedule_class_atomic(uuid, uuid, uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
end;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: unwind_reschedule_atomic(uuid, uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_net_delta numeric;
  v_dummy numeric;
  v_rows int;
begin
  v_net_delta := p_new_duration_hours - p_old_duration_hours;

  select hours_consumed into v_dummy
    from trainings
    where id = p_training_id
    for update;

  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  update lessons
    set status = 'scheduled',
        cancelled_at = null,
        cancellation_reason = null,
        updated_at = now()
    where id = p_old_lesson_id
      and status = 'cancelled';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'old_lesson_not_restorable' using errcode = 'P0001';
  end if;

  update trainings
    set hours_consumed = hours_consumed - v_net_delta
    where id = p_training_id;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    linked_entity_type text,
    linked_entity_id uuid,
    assigned_to uuid NOT NULL,
    due_date date,
    priority text DEFAULT 'medium'::text NOT NULL,
    follow_up_reason text DEFAULT 'general'::text NOT NULL,
    notes text,
    status text DEFAULT 'open'::text NOT NULL,
    completed_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: announcement_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_dismissals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    announcement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_type text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    target_audience text DEFAULT 'everyone'::text NOT NULL,
    target_id uuid,
    is_dismissable boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lesson_id uuid,
    student_id uuid NOT NULL,
    study_sheet_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    type text NOT NULL,
    day_of_week integer,
    start_time time without time zone,
    end_time time without time zone,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    is_available boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT availability_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT availability_type_check CHECK ((type = ANY (ARRAY['general'::text, 'specific'::text, 'holiday'::text])))
);


--
-- Name: availability_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    is_available boolean DEFAULT false NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: availability_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    day_of_week integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT availability_templates_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: booking_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    student_id uuid NOT NULL,
    training_id uuid,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    teams_link text,
    teams_meeting_id text,
    status text DEFAULT 'scheduled'::text,
    lesson_notes text,
    cancellation_reason text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT classes_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text, 'no_show_student'::text, 'no_show_teacher'::text])))
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'b2b'::text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    country text,
    billing_email text,
    cancellation_policy text DEFAULT '24hr'::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cron_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cron_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cron_name text NOT NULL,
    run_date date NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: exercise_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exercise_completions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    sheet_id uuid NOT NULL,
    assignment_id uuid,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    score integer
);


--
-- Name: exercises; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exercises (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    study_sheet_id uuid NOT NULL,
    question_text text NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    correct_answer text NOT NULL,
    explanation text,
    duration_minutes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: faqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.faqs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    target_audience text NOT NULL,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT faqs_target_audience_check CHECK ((target_audience = ANY (ARRAY['teacher'::text, 'student'::text, 'both'::text])))
);


--
-- Name: hours_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hours_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    type text NOT NULL,
    amount_hours numeric(5,2) NOT NULL,
    balance_after numeric(5,2) NOT NULL,
    invoice_reference text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    billing_month date NOT NULL,
    amount_eur numeric(10,2),
    status text DEFAULT 'pending'::text NOT NULL,
    file_path text,
    uploaded_at timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reference_number text,
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'paid'::text, 'late'::text])))
);


--
-- Name: lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lessons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    training_id uuid NOT NULL,
    teacher_id uuid NOT NULL,
    student_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    duration_minutes integer DEFAULT 60 NOT NULL,
    teams_meeting_id text,
    teams_join_url text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    cancelled_at timestamp with time zone,
    cancellation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reminder_24_sent boolean DEFAULT false NOT NULL,
    reminder_1h_sent boolean DEFAULT false NOT NULL,
    report_overdue_sent boolean DEFAULT false NOT NULL,
    cancelled_by text,
    hours_refunded boolean DEFAULT false,
    CONSTRAINT lessons_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text, 'cancelled_by_student'::text, 'cancelled_by_teacher'::text, 'student_no_show'::text, 'teacher_no_show'::text])))
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_address text NOT NULL,
    portal text NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_id uuid NOT NULL,
    sender_type text NOT NULL,
    receiver_id uuid NOT NULL,
    receiver_type text NOT NULL,
    content text NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_receiver_type_check CHECK ((receiver_type = ANY (ARRAY['teacher'::text, 'admin'::text, 'student'::text]))),
    CONSTRAINT messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['teacher'::text, 'admin'::text, 'student'::text])))
);

ALTER TABLE ONLY public.messages REPLICA IDENTITY FULL;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'teacher'::text NOT NULL,
    photo_url text,
    timezone text NOT NULL,
    bio text,
    teaching_languages text[] DEFAULT '{}'::text[],
    speaking_languages text[] DEFAULT '{}'::text[],
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preferred_payment_type text DEFAULT 'bank'::text,
    paypal_email text,
    iban text,
    bic text,
    tax_number text,
    street_address text,
    area_code text,
    city text,
    hourly_rate numeric,
    contract_start date,
    orientation_date date,
    observed_lesson_date date,
    vat_required boolean DEFAULT false NOT NULL,
    account_types text[] DEFAULT ARRAY['teacher'::text] NOT NULL,
    teacher_type text DEFAULT 'teacher'::text NOT NULL,
    status text DEFAULT 'current'::text NOT NULL,
    follow_up_date date,
    follow_up_reason text,
    admin_notes text,
    native_languages text[] DEFAULT '{}'::text[] NOT NULL,
    specialties text,
    quote text,
    video_url text,
    title text,
    gender text,
    nationality text,
    phone text,
    date_of_birth date,
    qualifications text,
    currency text DEFAULT 'EUR'::text,
    must_change_password boolean DEFAULT false,
    profile_completed boolean DEFAULT false,
    banking_details text,
    profile_banner_dismissed boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['teacher'::text, 'admin'::text])))
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lesson_id uuid NOT NULL,
    teacher_id uuid NOT NULL,
    did_class_happen boolean,
    no_show_type text,
    feedback_text text,
    additional_details text,
    level_data jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    flagged_at timestamp with time zone,
    completed_at timestamp with time zone,
    deadline_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    student_confirmed boolean DEFAULT true,
    impersonation_note text,
    CONSTRAINT reports_no_show_type_check CHECK ((no_show_type = ANY (ARRAY['student'::text, 'teacher'::text]))),
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'flagged'::text, 'reopened'::text])))
);


--
-- Name: resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    description text,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    student_id uuid NOT NULL,
    rating integer NOT NULL,
    review_text text,
    is_visible boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    class_id uuid,
    moderated_by_admin boolean DEFAULT false,
    admin_edited_text text,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: student_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    class_id uuid,
    student_id uuid,
    teacher_id uuid,
    rating integer NOT NULL,
    review_text text,
    submitted_at timestamp with time zone DEFAULT now(),
    moderated_by_admin boolean DEFAULT false,
    admin_edited_text text,
    CONSTRAINT student_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: students; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.students (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    photo_url text,
    timezone text NOT NULL,
    auth_user_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    language_preference text,
    learning_goals text,
    interests text,
    self_assessed_level text,
    placement_test_result text,
    placement_test_taken_at timestamp with time zone,
    company_id uuid,
    cancellation_policy text DEFAULT '24hr'::text NOT NULL,
    customer_number text,
    is_private boolean DEFAULT true NOT NULL,
    academic_advisor_id uuid,
    status text DEFAULT 'current'::text NOT NULL,
    follow_up_date date,
    follow_up_reason text,
    admin_notes text,
    teacher_notes text,
    date_of_birth date,
    phone text,
    native_language text,
    learning_language text,
    current_fluency_level text,
    profile_completed boolean DEFAULT false,
    must_change_password boolean DEFAULT true,
    profile_banner_dismissed boolean DEFAULT false NOT NULL
);


--
-- Name: study_sheets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_sheets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    level text NOT NULL,
    difficulty integer DEFAULT 1 NOT NULL,
    content jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_roles text[] DEFAULT ARRAY['teacher'::text, 'teacher_exam'::text] NOT NULL,
    intro_text text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT study_sheets_category_check CHECK ((category = ANY (ARRAY['vocabulary'::text, 'grammar'::text]))),
    CONSTRAINT study_sheets_difficulty_check CHECK (((difficulty >= 1) AND (difficulty <= 5)))
);


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    participant_id text NOT NULL,
    participant_type text NOT NULL,
    participant_auth_id uuid NOT NULL,
    sender_role text NOT NULL,
    content text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT support_messages_participant_type_check CHECK ((participant_type = ANY (ARRAY['teacher'::text, 'student'::text]))),
    CONSTRAINT support_messages_sender_role_check CHECK ((sender_role = ANY (ARRAY['user'::text, 'admin'::text])))
);

ALTER TABLE ONLY public.support_messages REPLICA IDENTITY FULL;


--
-- Name: teacher_history_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teacher_history_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: training_teachers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_teachers (
    training_id uuid NOT NULL,
    teacher_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trainings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trainings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    total_hours numeric(6,2) DEFAULT 0 NOT NULL,
    hours_consumed numeric(6,2) DEFAULT 0 NOT NULL,
    start_date date,
    end_date date,
    package_type text,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    teacher_id uuid,
    low_hours_warning_sent boolean DEFAULT false NOT NULL,
    package_name text,
    training_ending_soon_sent boolean DEFAULT false NOT NULL,
    CONSTRAINT trainings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'paused'::text])))
);


--
-- Name: user_action_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_action_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    bucket text NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_action_attempts_bucket_check CHECK ((bucket = ANY (ARRAY['email_dispatch'::text, 'admin_hours_mutation'::text])))
);


--
-- Name: admin_tasks admin_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tasks
    ADD CONSTRAINT admin_tasks_pkey PRIMARY KEY (id);


--
-- Name: announcement_dismissals announcement_dismissals_announcement_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_dismissals
    ADD CONSTRAINT announcement_dismissals_announcement_id_user_id_key UNIQUE (announcement_id, user_id);


--
-- Name: announcement_dismissals announcement_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_dismissals
    ADD CONSTRAINT announcement_dismissals_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: assignments assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_pkey PRIMARY KEY (id);


--
-- Name: availability_overrides availability_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_overrides
    ADD CONSTRAINT availability_overrides_pkey PRIMARY KEY (id);


--
-- Name: availability availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_pkey PRIMARY KEY (id);


--
-- Name: availability_templates availability_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_templates
    ADD CONSTRAINT availability_templates_pkey PRIMARY KEY (id);


--
-- Name: booking_attempts booking_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_attempts
    ADD CONSTRAINT booking_attempts_pkey PRIMARY KEY (id);


--
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: cron_runs cron_runs_cron_name_run_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cron_runs
    ADD CONSTRAINT cron_runs_cron_name_run_date_key UNIQUE (cron_name, run_date);


--
-- Name: cron_runs cron_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cron_runs
    ADD CONSTRAINT cron_runs_pkey PRIMARY KEY (id);


--
-- Name: exercise_completions exercise_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercise_completions
    ADD CONSTRAINT exercise_completions_pkey PRIMARY KEY (id);


--
-- Name: exercises exercises_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercises
    ADD CONSTRAINT exercises_pkey PRIMARY KEY (id);


--
-- Name: faqs faqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.faqs
    ADD CONSTRAINT faqs_pkey PRIMARY KEY (id);


--
-- Name: hours_log hours_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_log
    ADD CONSTRAINT hours_log_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_reference_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_reference_number_key UNIQUE (reference_number);


--
-- Name: invoices invoices_teacher_id_billing_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_teacher_id_billing_month_key UNIQUE (teacher_id, billing_month);


--
-- Name: lessons lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_pkey PRIMARY KEY (id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: lessons no_teacher_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT no_teacher_overlap EXCLUDE USING gist (teacher_id WITH =, tstzrange(scheduled_at, public.lesson_end_time(scheduled_at, duration_minutes), '[)'::text) WITH &&) WHERE ((status = 'scheduled'::text));


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: reports reports_lesson_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_lesson_id_key UNIQUE (lesson_id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: student_reviews student_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_reviews
    ADD CONSTRAINT student_reviews_pkey PRIMARY KEY (id);


--
-- Name: students students_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_email_key UNIQUE (email);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);


--
-- Name: study_sheets study_sheets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sheets
    ADD CONSTRAINT study_sheets_pkey PRIMARY KEY (id);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: teacher_history_log teacher_history_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_history_log
    ADD CONSTRAINT teacher_history_log_pkey PRIMARY KEY (id);


--
-- Name: training_teachers training_teachers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_teachers
    ADD CONSTRAINT training_teachers_pkey PRIMARY KEY (training_id, teacher_id);


--
-- Name: trainings trainings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainings
    ADD CONSTRAINT trainings_pkey PRIMARY KEY (id);


--
-- Name: availability unique_general_slot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT unique_general_slot UNIQUE (teacher_id, day_of_week, start_time, end_time);


--
-- Name: user_action_attempts user_action_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_action_attempts
    ADD CONSTRAINT user_action_attempts_pkey PRIMARY KEY (id);


--
-- Name: availability_overrides_teacher_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX availability_overrides_teacher_id_idx ON public.availability_overrides USING btree (teacher_id);


--
-- Name: availability_templates_teacher_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX availability_templates_teacher_id_idx ON public.availability_templates USING btree (teacher_id);


--
-- Name: booking_attempts_student_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_attempts_student_window_idx ON public.booking_attempts USING btree (student_id, attempted_at DESC);


--
-- Name: idx_user_action_attempts_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_action_attempts_lookup ON public.user_action_attempts USING btree (user_id, bucket, attempted_at DESC);


--
-- Name: invoices_teacher_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_teacher_id_idx ON public.invoices USING btree (teacher_id);


--
-- Name: lessons_scheduled_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lessons_scheduled_at_idx ON public.lessons USING btree (scheduled_at);


--
-- Name: lessons_student_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lessons_student_id_idx ON public.lessons USING btree (student_id);


--
-- Name: lessons_teacher_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lessons_teacher_id_idx ON public.lessons USING btree (teacher_id);


--
-- Name: login_attempts_ip_address_attempted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_attempts_ip_address_attempted_at_idx ON public.login_attempts USING btree (ip_address, attempted_at);


--
-- Name: messages_receiver_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_receiver_id_idx ON public.messages USING btree (receiver_id);


--
-- Name: messages_sender_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_sender_id_idx ON public.messages USING btree (sender_id);


--
-- Name: reports_lesson_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_lesson_id_idx ON public.reports USING btree (lesson_id);


--
-- Name: reports_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_status_idx ON public.reports USING btree (status);


--
-- Name: reports_teacher_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_teacher_id_idx ON public.reports USING btree (teacher_id);


--
-- Name: admin_tasks admin_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tasks
    ADD CONSTRAINT admin_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id);


--
-- Name: admin_tasks admin_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tasks
    ADD CONSTRAINT admin_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: announcement_dismissals announcement_dismissals_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_dismissals
    ADD CONSTRAINT announcement_dismissals_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: announcements announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: assignments assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.profiles(id);


--
-- Name: assignments assignments_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE SET NULL;


--
-- Name: assignments assignments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: assignments assignments_study_sheet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_study_sheet_id_fkey FOREIGN KEY (study_sheet_id) REFERENCES public.study_sheets(id) ON DELETE CASCADE;


--
-- Name: availability_overrides availability_overrides_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_overrides
    ADD CONSTRAINT availability_overrides_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: availability availability_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: availability_templates availability_templates_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_templates
    ADD CONSTRAINT availability_templates_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: booking_attempts booking_attempts_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_attempts
    ADD CONSTRAINT booking_attempts_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: classes classes_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: classes classes_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: classes classes_training_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_training_id_fkey FOREIGN KEY (training_id) REFERENCES public.trainings(id) ON DELETE SET NULL;


--
-- Name: exercise_completions exercise_completions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercise_completions
    ADD CONSTRAINT exercise_completions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE SET NULL;


--
-- Name: exercise_completions exercise_completions_sheet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercise_completions
    ADD CONSTRAINT exercise_completions_sheet_id_fkey FOREIGN KEY (sheet_id) REFERENCES public.study_sheets(id) ON DELETE CASCADE;


--
-- Name: exercise_completions exercise_completions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercise_completions
    ADD CONSTRAINT exercise_completions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: exercises exercises_study_sheet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exercises
    ADD CONSTRAINT exercises_study_sheet_id_fkey FOREIGN KEY (study_sheet_id) REFERENCES public.study_sheets(id) ON DELETE CASCADE;


--
-- Name: students fk_students_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT fk_students_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: hours_log hours_log_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_log
    ADD CONSTRAINT hours_log_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: hours_log hours_log_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_log
    ADD CONSTRAINT hours_log_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: lessons lessons_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: lessons lessons_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id);


--
-- Name: lessons lessons_training_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_training_id_fkey FOREIGN KEY (training_id) REFERENCES public.trainings(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: reports reports_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: reports reports_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id);


--
-- Name: reviews reviews_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.lessons(id) ON DELETE SET NULL;


--
-- Name: reviews reviews_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: student_reviews student_reviews_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_reviews
    ADD CONSTRAINT student_reviews_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: student_reviews student_reviews_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_reviews
    ADD CONSTRAINT student_reviews_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_reviews student_reviews_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_reviews
    ADD CONSTRAINT student_reviews_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: students students_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: teacher_history_log teacher_history_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_history_log
    ADD CONSTRAINT teacher_history_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.profiles(id);


--
-- Name: teacher_history_log teacher_history_log_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_history_log
    ADD CONSTRAINT teacher_history_log_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: training_teachers training_teachers_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_teachers
    ADD CONSTRAINT training_teachers_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: training_teachers training_teachers_training_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_teachers
    ADD CONSTRAINT training_teachers_training_id_fkey FOREIGN KEY (training_id) REFERENCES public.trainings(id) ON DELETE CASCADE;


--
-- Name: trainings trainings_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainings
    ADD CONSTRAINT trainings_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: trainings trainings_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainings
    ADD CONSTRAINT trainings_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: announcements Admin full access to announcements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to announcements" ON public.announcements TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: companies Admin full access to companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to companies" ON public.companies TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: hours_log Admin full access to hours_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to hours_log" ON public.hours_log TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: student_reviews Admin full access to student_reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to student_reviews" ON public.student_reviews TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: admin_tasks Admin full access to tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to tasks" ON public.admin_tasks TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: training_teachers Admin full access to training_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin full access to training_teachers" ON public.training_teachers TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: teacher_history_log Admin only access to teacher_history_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin only access to teacher_history_log" ON public.teacher_history_log TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: announcement_dismissals Admin reads all dismissals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin reads all dismissals" ON public.announcement_dismissals FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: students Admin reads all students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin reads all students" ON public.students FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: students Admin updates all students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin updates all students" ON public.students FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: exercises Admins can delete exercises; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete exercises" ON public.exercises FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: study_sheets Admins can delete study sheets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete study sheets" ON public.study_sheets FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: exercises Admins can insert exercises; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert exercises" ON public.exercises FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: lessons Admins can insert lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert lessons" ON public.lessons FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: study_sheets Admins can insert study sheets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert study sheets" ON public.study_sheets FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: trainings Admins can insert trainings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert trainings" ON public.trainings FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: classes Admins can manage all classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all classes" ON public.classes TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: resources Admins can manage resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage resources" ON public.resources TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: settings Admins can manage settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage settings" ON public.settings TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: lessons Admins can read all lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all lessons" ON public.lessons FOR SELECT USING (public.is_admin());


--
-- Name: reviews Admins can read all reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all reviews" ON public.reviews FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: reports Admins can update all reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update all reports" ON public.reports FOR UPDATE TO authenticated USING (public.is_admin());


--
-- Name: exercises Admins can update exercises; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update exercises" ON public.exercises FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: lessons Admins can update lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update lessons" ON public.lessons FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: reviews Admins can update reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update reviews" ON public.reviews FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: study_sheets Admins can update study sheets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update study sheets" ON public.study_sheets FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: trainings Admins can update trainings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update trainings" ON public.trainings FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: reports Admins can view all reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all reports" ON public.reports FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: trainings Admins can view all trainings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all trainings" ON public.trainings FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: admin_tasks Assigned staff read and update their tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Assigned staff read and update their tasks" ON public.admin_tasks FOR SELECT TO authenticated USING ((assigned_to = auth.uid()));


--
-- Name: admin_tasks Assigned staff update their tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Assigned staff update their tasks" ON public.admin_tasks FOR UPDATE TO authenticated USING ((assigned_to = auth.uid())) WITH CHECK ((assigned_to = auth.uid()));


--
-- Name: resources Authenticated users can read resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read resources" ON public.resources FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: settings Authenticated users can read settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read settings" ON public.settings FOR SELECT TO authenticated USING (true);


--
-- Name: exercises Authenticated users can view exercises; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view exercises" ON public.exercises FOR SELECT TO authenticated USING (true);


--
-- Name: profiles Authenticated users can view profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view profiles" ON public.profiles FOR SELECT TO authenticated USING (true);


--
-- Name: study_sheets Authenticated users can view study sheets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view study sheets" ON public.study_sheets FOR SELECT TO authenticated USING ((auth.role() = 'authenticated'::text));


--
-- Name: announcements Authenticated users read active announcements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users read active announcements" ON public.announcements FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: messages Recipients can mark as read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Recipients can mark as read" ON public.messages FOR UPDATE TO authenticated USING (((receiver_id = auth.uid()) OR (receiver_id = ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))))) WITH CHECK (((receiver_id = auth.uid()) OR (receiver_id = ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid())))));


--
-- Name: lessons Students can cancel their own lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students can cancel their own lessons" ON public.lessons FOR UPDATE TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid())))) WITH CHECK ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: messages Students can send messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students can send messages" ON public.messages FOR INSERT TO authenticated WITH CHECK (((sender_id = ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))) AND (sender_type = 'student'::text)));


--
-- Name: lessons Students insert own lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students insert own lessons" ON public.lessons FOR INSERT TO authenticated WITH CHECK ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: student_reviews Students insert own reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students insert own reviews" ON public.student_reviews FOR INSERT TO authenticated WITH CHECK ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: reviews Students insert own reviews on reviews table; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students insert own reviews on reviews table" ON public.reviews FOR INSERT TO authenticated WITH CHECK ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: availability_overrides Students read availability_overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read availability_overrides" ON public.availability_overrides FOR SELECT TO authenticated USING (true);


--
-- Name: availability_templates Students read availability_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read availability_templates" ON public.availability_templates FOR SELECT TO authenticated USING (true);


--
-- Name: assignments Students read own assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own assignments" ON public.assignments FOR SELECT TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: hours_log Students read own hours_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own hours_log" ON public.hours_log FOR SELECT TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: lessons Students read own lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own lessons" ON public.lessons FOR SELECT TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: student_reviews Students read own reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own reviews" ON public.student_reviews FOR SELECT TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: students Students read own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own row" ON public.students FOR SELECT TO authenticated USING ((auth_user_id = auth.uid()));


--
-- Name: training_teachers Students read own training_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own training_teachers" ON public.training_teachers FOR SELECT USING ((training_id IN ( SELECT trainings.id
   FROM public.trainings
  WHERE (trainings.student_id = public.get_current_student_id()))));


--
-- Name: trainings Students read own trainings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students read own trainings" ON public.trainings FOR SELECT USING ((student_id = public.get_current_student_id()));


--
-- Name: students Students update own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students update own row" ON public.students FOR UPDATE TO authenticated USING ((auth_user_id = auth.uid())) WITH CHECK ((auth_user_id = auth.uid()));


--
-- Name: invoices Teachers and admins can update invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers and admins can update invoices" ON public.invoices FOR UPDATE TO authenticated USING (((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))) OR ((teacher_id = auth.uid()) AND (billing_month = (date_trunc('month'::text, ((now() AT TIME ZONE COALESCE(( SELECT profiles.timezone
   FROM public.profiles
  WHERE (profiles.id = auth.uid())), 'UTC'::text)) - '1 mon'::interval)))::date) AND ((EXTRACT(day FROM (now() AT TIME ZONE COALESCE(( SELECT profiles.timezone
   FROM public.profiles
  WHERE (profiles.id = auth.uid())), 'UTC'::text))) >= (1)::numeric) AND (EXTRACT(day FROM (now() AT TIME ZONE COALESCE(( SELECT profiles.timezone
   FROM public.profiles
  WHERE (profiles.id = auth.uid())), 'UTC'::text))) <= (10)::numeric)))));


--
-- Name: availability Teachers can delete own availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can delete own availability" ON public.availability FOR DELETE TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: assignments Teachers can insert assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can insert assignments" ON public.assignments FOR INSERT TO authenticated WITH CHECK ((assigned_by = auth.uid()));


--
-- Name: availability Teachers can insert own availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can insert own availability" ON public.availability FOR INSERT TO authenticated WITH CHECK ((teacher_id = auth.uid()));


--
-- Name: invoices Teachers can insert own invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can insert own invoices" ON public.invoices FOR INSERT TO authenticated WITH CHECK ((teacher_id = auth.uid()));


--
-- Name: reports Teachers can insert own reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can insert own reports" ON public.reports FOR INSERT TO authenticated WITH CHECK ((teacher_id = auth.uid()));


--
-- Name: reviews Teachers can read own reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can read own reviews" ON public.reviews FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: reports Teachers can update own pending reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can update own pending reports" ON public.reports FOR UPDATE TO authenticated USING (((teacher_id = auth.uid()) AND (status = ANY (ARRAY['pending'::text, 'reopened'::text])))) WITH CHECK (((teacher_id = auth.uid()) AND (status = ANY (ARRAY['pending'::text, 'reopened'::text]))));


--
-- Name: classes Teachers can update their own lesson notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can update their own lesson notes" ON public.classes FOR UPDATE TO authenticated USING ((teacher_id = auth.uid())) WITH CHECK ((teacher_id = auth.uid()));


--
-- Name: assignments Teachers can view assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view assignments" ON public.assignments FOR SELECT TO authenticated USING ((assigned_by = auth.uid()));


--
-- Name: availability Teachers can view own availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view own availability" ON public.availability FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: invoices Teachers can view own invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view own invoices" ON public.invoices FOR SELECT TO authenticated USING (((teacher_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: reports Teachers can view own reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view own reports" ON public.reports FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: trainings Teachers can view own trainings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view own trainings" ON public.trainings FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: classes Teachers can view their own classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can view their own classes" ON public.classes FOR SELECT TO authenticated USING (((teacher_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: availability Teachers manage own availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers manage own availability" ON public.availability TO authenticated USING (((teacher_id = auth.uid()) OR public.is_admin())) WITH CHECK (((teacher_id = auth.uid()) OR public.is_admin()));


--
-- Name: availability_overrides Teachers manage own availability_overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers manage own availability_overrides" ON public.availability_overrides TO authenticated USING (((teacher_id = auth.uid()) OR public.is_admin())) WITH CHECK (((teacher_id = auth.uid()) OR public.is_admin()));


--
-- Name: availability_templates Teachers manage own availability_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers manage own availability_templates" ON public.availability_templates TO authenticated USING (((teacher_id = auth.uid()) OR public.is_admin())) WITH CHECK (((teacher_id = auth.uid()) OR public.is_admin()));


--
-- Name: students Teachers read own students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers read own students" ON public.students FOR SELECT TO authenticated USING ((id IN ( SELECT tt.student_id
   FROM (public.trainings tt
     JOIN public.training_teachers tch ON ((tch.training_id = tt.id)))
  WHERE (tch.teacher_id = auth.uid()))));


--
-- Name: training_teachers Teachers read own training_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers read own training_teachers" ON public.training_teachers FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: lessons Teachers see own lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers see own lessons" ON public.lessons FOR SELECT TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: messages Users can insert messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert messages" ON public.messages FOR INSERT TO authenticated WITH CHECK ((auth.uid() = sender_id));


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (((id = auth.uid()) OR public.is_admin())) WITH CHECK (((id = auth.uid()) OR public.is_admin()));


--
-- Name: announcement_dismissals Users insert own dismissals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own dismissals" ON public.announcement_dismissals FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: announcement_dismissals Users read own dismissals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read own dismissals" ON public.announcement_dismissals FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: messages Users see their own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own messages" ON public.messages FOR SELECT TO authenticated USING (((sender_id = auth.uid()) OR (receiver_id = auth.uid()) OR (sender_id = ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))) OR (receiver_id = ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))) OR (public.get_user_role() = 'admin'::text)));


--
-- Name: exercise_completions admin_exercise_completions_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_exercise_completions_all ON public.exercise_completions TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: admin_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: announcement_dismissals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcement_dismissals ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: availability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.availability ENABLE ROW LEVEL SECURITY;

--
-- Name: availability_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.availability_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: availability_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.availability_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: classes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: cron_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: exercise_completions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exercise_completions ENABLE ROW LEVEL SECURITY;

--
-- Name: exercises; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exercises ENABLE ROW LEVEL SECURITY;

--
-- Name: faqs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;

--
-- Name: faqs faqs_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY faqs_admin_all ON public.faqs TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: faqs faqs_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY faqs_authenticated_read ON public.faqs FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: hours_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hours_log ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: lessons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;

--
-- Name: login_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: exercise_completions student_exercise_completions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_exercise_completions_insert ON public.exercise_completions FOR INSERT TO authenticated WITH CHECK ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: exercise_completions student_exercise_completions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_exercise_completions_select ON public.exercise_completions FOR SELECT TO authenticated USING ((student_id IN ( SELECT students.id
   FROM public.students
  WHERE (students.auth_user_id = auth.uid()))));


--
-- Name: student_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews student_reviews_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_reviews_select ON public.reviews FOR SELECT USING ((student_id = public.get_current_student_id()));


--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

--
-- Name: study_sheets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_sheets ENABLE ROW LEVEL SECURITY;

--
-- Name: support_messages support_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_admin_insert ON public.support_messages FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: support_messages support_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_admin_select ON public.support_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: support_messages support_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_admin_update ON public.support_messages FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: support_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: support_messages support_user_mark_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_user_mark_read ON public.support_messages FOR UPDATE TO authenticated USING ((participant_auth_id = auth.uid())) WITH CHECK ((participant_auth_id = auth.uid()));


--
-- Name: support_messages support_user_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_user_select ON public.support_messages FOR SELECT TO authenticated USING ((participant_auth_id = auth.uid()));


--
-- Name: exercise_completions teacher_exercise_completions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teacher_exercise_completions_select ON public.exercise_completions FOR SELECT TO authenticated USING ((student_id IN ( SELECT trainings.student_id
   FROM public.trainings
  WHERE (trainings.teacher_id = auth.uid()))));


--
-- Name: teacher_history_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teacher_history_log ENABLE ROW LEVEL SECURITY;

--
-- Name: training_teachers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_teachers ENABLE ROW LEVEL SECURITY;

--
-- Name: trainings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trainings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_action_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_action_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION book_class_atomic(p_training_id uuid, p_hours_needed numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.book_class_atomic(p_training_id uuid, p_hours_needed numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.book_class_atomic(p_training_id uuid, p_hours_needed numeric) TO service_role;


--
-- Name: FUNCTION cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean) TO service_role;


--
-- Name: FUNCTION change_duration_atomic(p_lesson_id uuid, p_old_duration_minutes integer, p_new_duration_minutes integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.change_duration_atomic(p_lesson_id uuid, p_old_duration_minutes integer, p_new_duration_minutes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.change_duration_atomic(p_lesson_id uuid, p_old_duration_minutes integer, p_new_duration_minutes integer) TO service_role;


--
-- Name: FUNCTION complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb) TO anon;
GRANT ALL ON FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.complete_report_atomic(p_report_id uuid, p_lesson_status text, p_report_payload jsonb) TO service_role;


--
-- Name: FUNCTION flag_overdue_reports(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.flag_overdue_reports() TO anon;
GRANT ALL ON FUNCTION public.flag_overdue_reports() TO authenticated;
GRANT ALL ON FUNCTION public.flag_overdue_reports() TO service_role;


--
-- Name: FUNCTION get_current_student_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_current_student_id() TO anon;
GRANT ALL ON FUNCTION public.get_current_student_id() TO authenticated;
GRANT ALL ON FUNCTION public.get_current_student_id() TO service_role;


--
-- Name: FUNCTION get_user_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_user_role() TO anon;
GRANT ALL ON FUNCTION public.get_user_role() TO authenticated;
GRANT ALL ON FUNCTION public.get_user_role() TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION lesson_end_time(starts_at timestamp with time zone, duration_minutes integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lesson_end_time(starts_at timestamp with time zone, duration_minutes integer) TO anon;
GRANT ALL ON FUNCTION public.lesson_end_time(starts_at timestamp with time zone, duration_minutes integer) TO authenticated;
GRANT ALL ON FUNCTION public.lesson_end_time(starts_at timestamp with time zone, duration_minutes integer) TO service_role;


--
-- Name: FUNCTION refund_hours_atomic(p_training_id uuid, p_hours numeric, p_lesson_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.refund_hours_atomic(p_training_id uuid, p_hours numeric, p_lesson_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.refund_hours_atomic(p_training_id uuid, p_hours numeric, p_lesson_id uuid) TO service_role;


--
-- Name: FUNCTION reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) TO anon;
GRANT ALL ON FUNCTION public.unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) TO authenticated;
GRANT ALL ON FUNCTION public.unwind_reschedule_atomic(p_old_lesson_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric) TO service_role;


--
-- Name: TABLE admin_tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_tasks TO anon;
GRANT ALL ON TABLE public.admin_tasks TO authenticated;
GRANT ALL ON TABLE public.admin_tasks TO service_role;


--
-- Name: TABLE announcement_dismissals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.announcement_dismissals TO anon;
GRANT ALL ON TABLE public.announcement_dismissals TO authenticated;
GRANT ALL ON TABLE public.announcement_dismissals TO service_role;


--
-- Name: TABLE announcements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.announcements TO anon;
GRANT ALL ON TABLE public.announcements TO authenticated;
GRANT ALL ON TABLE public.announcements TO service_role;


--
-- Name: TABLE assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.assignments TO anon;
GRANT ALL ON TABLE public.assignments TO authenticated;
GRANT ALL ON TABLE public.assignments TO service_role;


--
-- Name: TABLE availability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.availability TO anon;
GRANT ALL ON TABLE public.availability TO authenticated;
GRANT ALL ON TABLE public.availability TO service_role;


--
-- Name: TABLE availability_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.availability_overrides TO anon;
GRANT ALL ON TABLE public.availability_overrides TO authenticated;
GRANT ALL ON TABLE public.availability_overrides TO service_role;


--
-- Name: TABLE availability_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.availability_templates TO anon;
GRANT ALL ON TABLE public.availability_templates TO authenticated;
GRANT ALL ON TABLE public.availability_templates TO service_role;


--
-- Name: TABLE booking_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_attempts TO anon;
GRANT ALL ON TABLE public.booking_attempts TO authenticated;
GRANT ALL ON TABLE public.booking_attempts TO service_role;


--
-- Name: TABLE classes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.classes TO anon;
GRANT ALL ON TABLE public.classes TO authenticated;
GRANT ALL ON TABLE public.classes TO service_role;


--
-- Name: TABLE companies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.companies TO anon;
GRANT ALL ON TABLE public.companies TO authenticated;
GRANT ALL ON TABLE public.companies TO service_role;


--
-- Name: TABLE cron_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cron_runs TO anon;
GRANT ALL ON TABLE public.cron_runs TO authenticated;
GRANT ALL ON TABLE public.cron_runs TO service_role;


--
-- Name: TABLE exercise_completions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exercise_completions TO anon;
GRANT ALL ON TABLE public.exercise_completions TO authenticated;
GRANT ALL ON TABLE public.exercise_completions TO service_role;


--
-- Name: TABLE exercises; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exercises TO anon;
GRANT ALL ON TABLE public.exercises TO authenticated;
GRANT ALL ON TABLE public.exercises TO service_role;


--
-- Name: TABLE faqs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.faqs TO anon;
GRANT ALL ON TABLE public.faqs TO authenticated;
GRANT ALL ON TABLE public.faqs TO service_role;


--
-- Name: TABLE hours_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hours_log TO anon;
GRANT ALL ON TABLE public.hours_log TO authenticated;
GRANT ALL ON TABLE public.hours_log TO service_role;


--
-- Name: TABLE invoices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invoices TO anon;
GRANT ALL ON TABLE public.invoices TO authenticated;
GRANT ALL ON TABLE public.invoices TO service_role;


--
-- Name: TABLE lessons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lessons TO anon;
GRANT ALL ON TABLE public.lessons TO authenticated;
GRANT ALL ON TABLE public.lessons TO service_role;


--
-- Name: TABLE login_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.login_attempts TO anon;
GRANT ALL ON TABLE public.login_attempts TO authenticated;
GRANT ALL ON TABLE public.login_attempts TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO service_role;
GRANT DELETE ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.profiles TO anon;
GRANT SELECT(id) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.email; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(email) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.full_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name) ON TABLE public.profiles TO anon;
GRANT SELECT(full_name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.photo_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(photo_url) ON TABLE public.profiles TO anon;
GRANT SELECT(photo_url) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.timezone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(timezone) ON TABLE public.profiles TO anon;
GRANT SELECT(timezone) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.bio; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(bio) ON TABLE public.profiles TO anon;
GRANT SELECT(bio) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.teaching_languages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(teaching_languages) ON TABLE public.profiles TO anon;
GRANT SELECT(teaching_languages) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.speaking_languages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(speaking_languages) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.is_active; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(is_active) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.preferred_payment_type; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(preferred_payment_type) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.street_address; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(street_address) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.area_code; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(area_code) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.city; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(city) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.contract_start; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(contract_start) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.orientation_date; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(orientation_date) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.observed_lesson_date; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(observed_lesson_date) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.vat_required; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(vat_required) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.account_types; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_types) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.teacher_type; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(teacher_type) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.follow_up_date; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(follow_up_date) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.follow_up_reason; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(follow_up_reason) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.native_languages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(native_languages) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.specialties; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(specialties) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.quote; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(quote) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.video_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(video_url) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.title; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(title) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.gender; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(gender) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.nationality; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(nationality) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.phone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(phone) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.date_of_birth; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(date_of_birth) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.qualifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(qualifications) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.currency; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(currency) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.must_change_password; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(must_change_password) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.profile_completed; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(profile_completed) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.profile_banner_dismissed; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(profile_banner_dismissed),UPDATE(profile_banner_dismissed) ON TABLE public.profiles TO authenticated;


--
-- Name: TABLE reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reports TO anon;
GRANT ALL ON TABLE public.reports TO authenticated;
GRANT ALL ON TABLE public.reports TO service_role;


--
-- Name: TABLE resources; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.resources TO anon;
GRANT ALL ON TABLE public.resources TO authenticated;
GRANT ALL ON TABLE public.resources TO service_role;


--
-- Name: TABLE reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reviews TO anon;
GRANT ALL ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;


--
-- Name: TABLE settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.settings TO anon;
GRANT ALL ON TABLE public.settings TO authenticated;
GRANT ALL ON TABLE public.settings TO service_role;


--
-- Name: TABLE student_reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_reviews TO anon;
GRANT ALL ON TABLE public.student_reviews TO authenticated;
GRANT ALL ON TABLE public.student_reviews TO service_role;


--
-- Name: TABLE students; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.students TO service_role;
GRANT DELETE ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.students TO anon;
GRANT SELECT(id) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.full_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.email; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(email) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.photo_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(photo_url) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.timezone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(timezone) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.auth_user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(auth_user_id) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.is_active; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(is_active) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.language_preference; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(language_preference) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.learning_goals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(learning_goals) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.interests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(interests) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.self_assessed_level; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(self_assessed_level) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.placement_test_result; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(placement_test_result) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.placement_test_taken_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(placement_test_taken_at) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.company_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(company_id) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.customer_number; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(customer_number) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.is_private; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(is_private) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.academic_advisor_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(academic_advisor_id) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.follow_up_date; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(follow_up_date) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.follow_up_reason; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(follow_up_reason) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.teacher_notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(teacher_notes) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.date_of_birth; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(date_of_birth) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.phone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(phone) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.native_language; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(native_language) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.learning_language; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(learning_language) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.current_fluency_level; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(current_fluency_level) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.profile_completed; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(profile_completed) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.must_change_password; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(must_change_password) ON TABLE public.students TO anon;
GRANT SELECT(must_change_password) ON TABLE public.students TO authenticated;


--
-- Name: COLUMN students.profile_banner_dismissed; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(profile_banner_dismissed),UPDATE(profile_banner_dismissed) ON TABLE public.students TO authenticated;


--
-- Name: TABLE study_sheets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.study_sheets TO anon;
GRANT ALL ON TABLE public.study_sheets TO authenticated;
GRANT ALL ON TABLE public.study_sheets TO service_role;


--
-- Name: TABLE support_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_messages TO anon;
GRANT ALL ON TABLE public.support_messages TO authenticated;
GRANT ALL ON TABLE public.support_messages TO service_role;


--
-- Name: TABLE teacher_history_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.teacher_history_log TO anon;
GRANT ALL ON TABLE public.teacher_history_log TO authenticated;
GRANT ALL ON TABLE public.teacher_history_log TO service_role;


--
-- Name: TABLE training_teachers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.training_teachers TO anon;
GRANT ALL ON TABLE public.training_teachers TO authenticated;
GRANT ALL ON TABLE public.training_teachers TO service_role;


--
-- Name: TABLE trainings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.trainings TO anon;
GRANT ALL ON TABLE public.trainings TO authenticated;
GRANT ALL ON TABLE public.trainings TO service_role;


--
-- Name: TABLE user_action_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_action_attempts TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict RYEhJ9at17abHBbZ5P4Y6imVkHVL9smkccbrxLv1LTG1bozwyVUJ3maG4M6gpkd

