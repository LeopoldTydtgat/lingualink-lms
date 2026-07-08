-- NEW262d (08 Jul 2026): Security audit item (d) - profiles.email was
-- readable by all authenticated users via the per-column grant model.
-- All RLS-bound readers were removed/moved to the admin client in
-- commit 63675f5. Applied live in SQL Editor 08 Jul 2026; this
-- migration captures that state for fresh environments.

REVOKE SELECT (email) ON public.profiles FROM authenticated;
