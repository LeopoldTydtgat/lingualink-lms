-- Applied live via Supabase SQL Editor on 27 Jul 2026.
-- Repair: repoint dangling students.academic_advisor_id rows (referenced
-- profile was hard-deleted from profiles and auth.users) to the admin
-- profile, then add the missing FK with ON DELETE SET NULL so future
-- profile deletions null the advisor instead of dangling.

UPDATE public.students
SET academic_advisor_id = '5285a0bc-c394-4d93-b10d-912283d5318e'
WHERE academic_advisor_id = '2c9e7d32-f4bb-459a-b64d-59ff4a6a5418';

ALTER TABLE public.students
  ADD CONSTRAINT students_academic_advisor_id_fkey
  FOREIGN KEY (academic_advisor_id)
  REFERENCES public.profiles(id)
  ON DELETE SET NULL;
