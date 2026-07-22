-- Role model rebuild: is_admin role-only, account_types check, role check backfill
--
-- These changes were applied live via the Supabase SQL editor on 21 Jul 2026 as
-- part of the role model rebuild. This migration backfills the repo so the
-- migration history matches the live database.
--
-- All statements are idempotent / guarded, so re-running this against the live
-- database is a no-op.

-- is_admin: role = 'admin' only; school_admin arm removed
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
$function$;

-- account_types restricted to teacher / teacher_exam / staff
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'profiles'::regclass
    AND conname = 'profiles_account_types_check'
  ) THEN
    ALTER TABLE profiles
    ADD CONSTRAINT profiles_account_types_check
    CHECK (account_types <@ ARRAY['teacher','teacher_exam','staff']::text[]);
  END IF;
END $$;

-- backfill: role check existed live-only, never captured in a migration
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'profiles'::regclass
    AND conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE profiles
    ADD CONSTRAINT profiles_role_check
    CHECK (role = ANY (ARRAY['teacher'::text, 'admin'::text]));
  END IF;
END $$;