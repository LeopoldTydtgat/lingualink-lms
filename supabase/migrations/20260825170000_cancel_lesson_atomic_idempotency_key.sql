-- BOOK-AUDIT 7: cancel_lesson_atomic idempotency key.
-- Applied by hand in the Supabase SQL Editor on 2026-08-25; captured here afterwards
-- from pg_get_functiondef against the live database.
--
-- Unlike book_class_atomic_keyed and reschedule_class_atomic_keyed, the key lives on
-- lessons rather than hours_log: a cancel with p_should_refund = false writes no ledger
-- row at all, so a ledger-based replay probe would be blind to every non-refunding cancel.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. If this file is ever
-- replayed by a migration runner that wraps each file in a transaction, drop CONCURRENTLY.

alter table public.lessons add column cancel_idempotency_key uuid;

create unique index concurrently if not exists lessons_cancel_idempotency_key_uidx
  on public.lessons (cancel_idempotency_key)
  where cancel_idempotency_key is not null;

CREATE OR REPLACE FUNCTION public.cancel_lesson_atomic_keyed(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_training_id      uuid;
  v_status           text;
  v_duration         int;
  v_already_refunded boolean;
  v_total            numeric;
  v_consumed         numeric;
  v_hours            numeric;
  v_new_status       text;
  v_refunded         boolean := false;
  v_rows             int;
  v_student_id       uuid;
  v_consumed_before  numeric;
  v_stored_key       uuid;
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
         l.cancel_idempotency_key,
         t.total_hours, t.hours_consumed, t.student_id
    into v_training_id, v_status, v_duration, v_already_refunded,
         v_stored_key,
         v_total, v_consumed, v_student_id
    from public.lessons l
    join public.trainings t on t.id = l.training_id
   where l.id = p_lesson_id
   for update of t;
  if not found then
    return jsonb_build_object('success', false, 'code', 'LESSON_NOT_FOUND');
  end if;

  -- BOOK-AUDIT 7 replay guard, position 1: sequential replay. Sits ABOVE the
  -- status check, because on a true replay the status is no longer 'scheduled'
  -- and the status check would mask the replay as LESSON_NOT_CANCELLABLE.
  -- LESSON_NOT_FOUND raises above this guard and proves nothing - hold, do not
  -- treat as rollback.
  if p_idempotency_key is not null and v_stored_key = p_idempotency_key then
    return jsonb_build_object(
      'success',         true,
      'replayed',        true,
      'status',          v_status,
      'refunded',        coalesce(v_already_refunded, false),
      'remaining_hours', greatest(0, v_total - v_consumed)
    );
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
     set status                 = v_new_status,
         cancelled_at           = now(),
         cancellation_reason    = p_cancellation_reason,
         cancelled_by           = p_cancelled_by,
         rescheduled_by         = null,
         rescheduled_at         = null,
         teams_join_url         = null,
         cancel_idempotency_key = p_idempotency_key,
         updated_at             = now()
   where id = p_lesson_id
     and status = 'scheduled';
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Replay guard, position 2: concurrent same-key race. The select above locks
    -- trainings only, so a second same-key call that queued on that lock resumes
    -- with a stale 'scheduled' snapshot of the lessons row and reaches here.
    -- Re-read under a fresh statement snapshot before deciding. Without this the
    -- probe would answer "did not commit" for a call that did commit.
    select l.status, l.hours_refunded, l.cancel_idempotency_key,
           t.total_hours, t.hours_consumed
      into v_status, v_already_refunded, v_stored_key,
           v_total, v_consumed
      from public.lessons l
      join public.trainings t on t.id = l.training_id
     where l.id = p_lesson_id;

    if p_idempotency_key is not null and v_stored_key = p_idempotency_key then
      return jsonb_build_object(
        'success',         true,
        'replayed',        true,
        'status',          v_status,
        'refunded',        coalesce(v_already_refunded, false),
        'remaining_hours', greatest(0, v_total - v_consumed)
      );
    end if;

    return jsonb_build_object(
      'success', false, 'code', 'LESSON_NOT_CANCELLABLE', 'current_status', v_status
    );
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
    'replayed',        false,
    'status',          v_new_status,
    'refunded',        v_refunded,
    'remaining_hours', greatest(0, v_total - v_consumed)
  );
end;
$function$
;

revoke execute on function public.cancel_lesson_atomic_keyed(uuid, text, text, boolean, uuid) from public;
revoke execute on function public.cancel_lesson_atomic_keyed(uuid, text, text, boolean, uuid) from anon;
revoke execute on function public.cancel_lesson_atomic_keyed(uuid, text, text, boolean, uuid) from authenticated;
grant execute on function public.cancel_lesson_atomic_keyed(uuid, text, text, boolean, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.cancel_lesson_atomic(p_lesson_id uuid, p_cancelled_by text, p_cancellation_reason text, p_should_refund boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- BOOK-AUDIT 7: kept as a null-key wrapper so the three existing 4-arg call
  -- sites keep working unchanged until each is migrated to the keyed RPC.
  return public.cancel_lesson_atomic_keyed(
    p_lesson_id, p_cancelled_by, p_cancellation_reason, p_should_refund, null
  );
end;
$function$
;
