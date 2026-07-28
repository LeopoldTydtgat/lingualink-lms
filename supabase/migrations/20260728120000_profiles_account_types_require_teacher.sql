-- Applied live via Supabase SQL Editor on 28 Jul 2026.
-- Client-locked role model: 'teacher' is always present on every profile;
-- 'teacher_exam' and 'staff' are additive extras layered on top of it, never
-- replacements for it. The old constraint only checked subset containment, so
-- a profile could be saved as ['staff'] alone. This one keeps the containment
-- check and additionally requires 'teacher' to be a member. All existing rows
-- complied at apply time.

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_account_types_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_types_check
  CHECK (
    account_types <@ ARRAY['teacher'::text, 'teacher_exam'::text, 'staff'::text]
    AND 'teacher' = ANY (account_types)
  );
