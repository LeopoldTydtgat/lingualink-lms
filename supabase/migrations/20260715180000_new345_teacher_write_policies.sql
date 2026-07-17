-- NEW345 Study Library rebuild - teacher write policies (statements 5-6), 15 Jul 2026
-- Captured verbatim from live DB after execution via SQL Editor (one statement per box).
-- Verified live via pg_policies read same session.
-- D1: p.status='current' required. D2: teacher_exam included. D4: NO teacher DELETE
-- policy, ever - soft delete is an is_active flip through the UPDATE policy below.
-- A hard DELETE would cascade lesson_annotations and exercise_completions.
-- WITH CHECK pins owner_id = auth.uid() AND audience = 'staff' on both commands:
-- owned sheets can never be flipped to student audience, released to the admin
-- library (owner_id NULL), or handed to another owner.
-- Post-hoc review findings (Opus + both subagents, Session 212): policies themselves
-- clean; surrounding issues tracked as TODO items (orphaned-storage id reuse, student
-- purge route missing owner_id preflight, stale "provably staff" column COMMENT,
-- CASCADE-vs-D4 FK action decision pending).
-- NOTE: the EXISTS account_types + status check does ALL the staff-ness work.
-- The FK to profiles(id) proves only that a profiles row exists (students can have
-- one too, e.g. dual-identity accounts). Never remove the EXISTS as "redundant".

create policy "Teachers insert own sheets"
on public.study_sheets
for insert
to authenticated
with check (
  (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.account_types @> array['teacher'::text] or p.account_types @> array['teacher_exam'::text])
      and p.status = 'current'
  ))
  and owner_id = auth.uid()
  and audience = 'staff'::text
);

create policy "Teachers update own sheets"
on public.study_sheets
for update
to authenticated
using (
  owner_id = auth.uid()
  and (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.account_types @> array['teacher'::text] or p.account_types @> array['teacher_exam'::text])
      and p.status = 'current'
  ))
)
with check (
  owner_id = auth.uid()
  and audience = 'staff'::text
  and (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.account_types @> array['teacher'::text] or p.account_types @> array['teacher_exam'::text])
      and p.status = 'current'
  ))
);
