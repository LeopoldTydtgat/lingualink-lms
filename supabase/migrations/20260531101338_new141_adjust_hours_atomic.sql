-- NEW141: adjust_hours_atomic - single locked path for all admin balance moves.
-- Replaces raw read-modify-write UPDATEs in two routes (manual add/remove hours,
-- and total_hours edits via the student profile form). Locks the training row
-- FOR UPDATE, applies the change, and writes the hours_log row in one tx so a
-- failed ledger insert rolls back the balance change. EXECUTE locked to
-- service_role to match the other hours RPCs (NEW143/NEW146 lesson).
-- p_action: 'add' grows total_hours | 'remove' grows hours_consumed | 'set_total' sets total_hours absolute.

CREATE OR REPLACE FUNCTION public.adjust_hours_atomic(
  p_training_id uuid,
  p_student_id uuid,
  p_action text,
  p_amount numeric,
  p_log_type text,
  p_created_by uuid,
  p_invoice_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS numeric
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
declare
  v_total numeric;
  v_consumed numeric;
  v_new_total numeric;
  v_new_consumed numeric;
  v_new_balance numeric;
  v_delta numeric;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  if p_action not in ('add', 'remove', 'set_total') then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  select total_hours, hours_consumed
    into v_total, v_consumed
    from public.trainings
   where id = p_training_id
     and student_id = p_student_id
   for update;

  if not found then
    raise exception 'training_not_found' using errcode = 'P0002';
  end if;

  v_new_total := v_total;
  v_new_consumed := v_consumed;

  if p_action = 'add' then
    if p_amount <= 0 then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;
    v_new_total := v_total + p_amount;
    v_delta := p_amount;
  elsif p_action = 'remove' then
    if p_amount <= 0 then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;
    if p_amount > (v_total - v_consumed) then
      raise exception 'insufficient_balance' using errcode = 'P0001';
    end if;
    v_new_consumed := v_consumed + p_amount;
    v_delta := -p_amount;
  else
    if p_amount < v_consumed then
      raise exception 'total_below_consumed' using errcode = 'P0001';
    end if;
    v_new_total := p_amount;
    v_delta := p_amount - v_total;
  end if;

  v_new_balance := v_new_total - v_new_consumed;

  update public.trainings
     set total_hours = v_new_total,
         hours_consumed = v_new_consumed,
         updated_at = now()
   where id = p_training_id;

  insert into public.hours_log
    (student_id, type, amount_hours, balance_after, invoice_reference, notes, created_by)
  values
    (p_student_id, p_log_type, v_delta, v_new_balance, p_invoice_reference, p_notes, p_created_by);

  return v_new_balance;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.adjust_hours_atomic(uuid, uuid, text, numeric, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_hours_atomic(uuid, uuid, text, numeric, text, uuid, text, text) TO service_role;