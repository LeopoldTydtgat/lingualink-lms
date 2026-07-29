-- Atomic delta swap of teacher assignments on a training.
-- Replaces the delete-then-insert in api/admin/students/[id]/route.ts:
-- fixes the zero-assignment failure window, blocks empty-set wipes,
-- and preserves assigned_at on unchanged rows.
-- Applied live via SQL Editor 29 Jul 2026. EXECUTE revoked below;
-- re-run the REVOKE if this function is ever dropped and recreated.

CREATE OR REPLACE FUNCTION public.swap_training_teachers(p_training_id uuid, p_teacher_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_ids uuid[];
  v_removed int;
  v_added int;
  v_final uuid[];
begin
  -- dedupe and strip nulls; reject empty set (kills the raw-API wipe)
  select array_agg(distinct t) into v_ids
    from unnest(coalesce(p_teacher_ids, '{}'::uuid[])) as t
   where t is not null;

  if v_ids is null then
    raise exception 'empty_teacher_set' using errcode = 'P0001';
  end if;

  -- lock the training; serialises concurrent swaps on the same training
  perform 1 from public.trainings where id = p_training_id for update;
  if not found then
    raise exception 'training_not_found' using errcode = 'P0002';
  end if;

  -- delta delete: only rows leaving the set
  delete from public.training_teachers
   where training_id = p_training_id
     and teacher_id <> all (v_ids);
  get diagnostics v_removed = row_count;

  -- delta insert: only rows not already present; unchanged rows keep assigned_at
  insert into public.training_teachers (training_id, teacher_id)
  select p_training_id, t from unnest(v_ids) as t
  on conflict (training_id, teacher_id) do nothing;
  get diagnostics v_added = row_count;

  select array_agg(teacher_id order by teacher_id) into v_final
    from public.training_teachers
   where training_id = p_training_id;

  return jsonb_build_object(
    'success', true,
    'removed', v_removed,
    'added', v_added,
    'final_teacher_ids', to_jsonb(v_final)
  );
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.swap_training_teachers(uuid, uuid[]) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.swap_training_teachers(uuid, uuid[]) TO service_role;
