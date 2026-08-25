-- BOOK-AUDIT 6, step 6: reschedule half of the idempotency-key work.
-- Applied live in the Supabase SQL Editor on 25 Aug 2026, captured here after.
--
-- Adds reschedule_class_atomic_keyed with a replay guard on
-- hours_log.idempotency_key, and rewrites reschedule_class_atomic as a thin
-- null-key wrapper at its original signature.

CREATE OR REPLACE FUNCTION public.reschedule_class_atomic_keyed(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total numeric;
  v_consumed numeric;
  v_net numeric;
  v_rows int;
  v_log_id uuid;
  v_lesson_id uuid;
begin
  -- Body of the old reschedule_class_atomic, unchanged, plus a replay guard
  -- keyed on hours_log.idempotency_key. With a null key it behaves exactly as
  -- before, which is how the reschedule_class_atomic wrapper calls it.
  select total_hours, hours_consumed
    into v_total, v_consumed
    from trainings
    where id = p_training_id
    for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0001';
  end if;

  -- Replay guard, deliberately AFTER the FOR UPDATE and not before it as in
  -- book_class_atomic_keyed. A same-key retry arriving while the first call is
  -- still in flight blocks HERE on the training lock, so by the time it reads
  -- hours_log the winner has committed and is visible. Checked before the lock
  -- it would miss, fall through to the lessons UPDATE, find the row already
  -- 'cancelled' and raise old_lesson_not_reschedulable - a P0001 the caller
  -- cannot tell apart from a genuine one. Booking has no equivalent exposure:
  -- its first mutation IS the keyed insert, so its unique_violation handler
  -- catches that race instead.
  --
  -- lesson_id here is the OLD lesson id (see the insert below), never the new
  -- one, and it is stamped unconditionally - so on a replay it is always
  -- non-null. The caller verifies it EQUALS the lesson it asked to move; a null
  -- or mismatched value means the key found somebody else's row.
  if p_idempotency_key is not null then
    select id, lesson_id into v_log_id, v_lesson_id
      from public.hours_log
     where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('log_id', v_log_id, 'replayed', true, 'lesson_id', v_lesson_id);
    end if;
  end if;

  begin
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
    -- The row is written on EVERY successful path, including a zero-net
    -- same-length move, which is what makes the key a complete record of the
    -- forward leg: replayed=true proves the cancel, the report delete and the
    -- hours move all committed together.
    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, lesson_id, idempotency_key)
    values (p_student_id, 'reschedule', -v_net, v_total - (v_consumed + v_net), null, p_old_lesson_id, p_idempotency_key)
    returning id into v_log_id;
  exception
    when unique_violation then
      -- Two requests carrying the same key against DIFFERENT trainings, which the
      -- lock above cannot serialise. This block is a subtransaction: catching
      -- here rolls back the lessons UPDATE, the reports DELETE and the trainings
      -- UPDATE as well as the failed insert, so the loser moves nothing.
      select id, lesson_id into v_log_id, v_lesson_id
        from public.hours_log
       where idempotency_key = p_idempotency_key;
      if not found then
        raise;  -- some other unique constraint, not ours: do not swallow it
      end if;
      return jsonb_build_object('log_id', v_log_id, 'replayed', true, 'lesson_id', v_lesson_id);
  end;

  return jsonb_build_object('log_id', v_log_id, 'replayed', false, 'lesson_id', p_old_lesson_id);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.reschedule_class_atomic_keyed(uuid, uuid, uuid, numeric, numeric, uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.reschedule_class_atomic_keyed(uuid, uuid, uuid, numeric, numeric, uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.reschedule_class_atomic_keyed(uuid, uuid, uuid, numeric, numeric, uuid) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.reschedule_class_atomic_keyed(uuid, uuid, uuid, numeric, numeric, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reschedule_class_atomic(p_old_lesson_id uuid, p_student_id uuid, p_training_id uuid, p_old_duration_hours numeric, p_new_duration_hours numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Thin wrapper kept at its original signature and return type so the code
  -- deployed on main keeps working while the keyed path rolls out. Passing a
  -- null key means no replay guard, i.e. the exact pre-25-Aug behaviour.
  -- Signature deliberately unchanged: no DROP FUNCTION, so EXECUTE grants stand.
  perform public.reschedule_class_atomic_keyed(p_old_lesson_id, p_student_id, p_training_id, p_old_duration_hours, p_new_duration_hours, null::uuid);
end;
$function$;
