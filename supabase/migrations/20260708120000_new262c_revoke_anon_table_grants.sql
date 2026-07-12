-- NEW262c (08 Jul 2026): Security audit item (c) - anon grant sweep.
-- Supabase default privileges granted anon ALL privileges on every table
-- in public. No RLS policy serves anon (verified via pg_policies); the
-- portal reads no data pre-login. Applied live in SQL Editor 08 Jul 2026;
-- this migration captures that state for fresh environments.

-- 1. Revoke all existing anon table grants in public
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- 2. Prevent future tables regrowing anon grants
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
