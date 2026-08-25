-- BOOK-AUDIT 6, step 1 of the idempotency-key work: booking half only.
-- Applied live in the Supabase SQL Editor on 25 Aug 2026, captured here after.
--
-- Problem: book_class_atomic has no replay guard. A booking whose response is
-- lost to the client, retried, deducts hours twice. The route cannot tell the
-- retry from a fresh booking because nothing in the request is unique per attempt
-- (the Teams meeting id is the only per-attempt value and it is minted AFTER the
-- money moves).
--
-- Shape: the logic moves into a new keyed function; book_class_atomic keeps its
-- exact signature and uuid return type and becomes a thin wrapper passing a null
-- key. That means the code deployed on main keeps booking unchanged while the
-- keyed path rolls out, there is one body rather than two that can drift, and
-- there is no DROP FUNCTION so EXECUTE grants are never reset.
--
-- reschedule_class_atomic is deliberately NOT touched here. Its old-lesson
-- status = 'scheduled' predicate already rejects a replay before any hours move,
-- so it is the lower-risk half and gets its own step once booking is proven.
--
-- Grants: Supabase default privileges grant EXECUTE on new public functions to
-- anon and authenticated DIRECTLY, not via PUBLIC, so REVOKE ... FROM PUBLIC does
-- not remove them. Both roles must be revoked by name. Verified after applying:
-- proacl on the new function matches book_class_atomic exactly.
--
-- hours_log grants are TABLE-level. Never add a column-level REVOKE to this
-- table: the first one flips it to column-grant mode and the select('*') at
-- (admin)/admin/students/[id]/page.tsx:336 starts returning null rows silently.

ALTER TABLE public.hours_log ADD COLUMN idempotency_key uuid;

CREATE UNIQUE INDEX hours_log_idempotency_key_uniq ON public.hours_log (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.book_class_atomic_keyed(p_training_id uuid, p_hours_needed numeric, p_idempotency_key uuid)
 RETURNS jsonb
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
  v_lesson_id uuid;
begin
  -- Body of the old book_class_atomic, unchanged, plus a replay guard keyed on
  -- hours_log.idempotency_key. With a null key it behaves exactly as before,
  -- which is how the book_class_atomic wrapper calls it.
  if p_hours_needed is null or p_hours_needed <= 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  -- Replay fast path: this key already moved hours, so move none. lesson_id is
  -- returned because the route backfills it after its insert; null here does
  -- NOT prove no lesson exists (the backfill is best-effort), so the caller
  -- must treat null as unknown, never as "safe to insert".
  if p_idempotency_key is not null then
    select id, lesson_id into v_log_id, v_lesson_id
      from public.hours_log
     where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('log_id', v_log_id, 'replayed', true, 'lesson_id', v_lesson_id);
    end if;
  end if;

  begin
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
    -- S476: stamp updated_at (student What's New hours-low seen-tracking keys on it).
    update public.trainings
       set hours_consumed = v_new_consumed,
           updated_at = now()
     where id = p_training_id;
    -- NEW257: lesson_id stays null, the route backfills it after its insert.
    insert into public.hours_log (student_id, type, amount_hours, balance_after, created_by, idempotency_key)
    values (v_student_id, 'class_booking', -p_hours_needed, v_total - v_new_consumed, null, p_idempotency_key)
    returning id into v_log_id;
  exception
    when unique_violation then
      -- Two requests carrying the same key raced past the pre-check. The insert
      -- only raises after the winner COMMITTED, so its row is visible now. This
      -- block is a subtransaction: catching here rolls back the trainings UPDATE
      -- as well as the failed insert, so the loser deducts nothing.
      select id, lesson_id into v_log_id, v_lesson_id
        from public.hours_log
       where idempotency_key = p_idempotency_key;
      if not found then
        raise;  -- some other unique constraint, not ours: do not swallow it
      end if;
      return jsonb_build_object('log_id', v_log_id, 'replayed', true, 'lesson_id', v_lesson_id);
  end;

  return jsonb_build_object('log_id', v_log_id, 'replayed', false, 'lesson_id', null::uuid);
end;
$function$;

CREATE OR REPLACE FUNCTION public.book_class_atomic(p_training_id uuid, p_hours_needed numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
begin
  -- Thin wrapper kept at its original signature and return type so the code
  -- deployed on main keeps working while the keyed path rolls out. Passing a
  -- null key means no replay guard, i.e. the exact pre-25-Aug behaviour.
  -- Signature deliberately unchanged: no DROP FUNCTION, so EXECUTE grants stand.
  v_result := public.book_class_atomic_keyed(p_training_id, p_hours_needed, null::uuid);
  return (v_result->>'log_id')::uuid;
end;
$function$;

REVOKE ALL ON FUNCTION public.book_class_atomic_keyed(uuid, numeric, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.book_class_atomic_keyed(uuid, numeric, uuid) FROM anon;

REVOKE ALL ON FUNCTION public.book_class_atomic_keyed(uuid, numeric, uuid) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.book_class_atomic_keyed(uuid, numeric, uuid) TO service_role;
