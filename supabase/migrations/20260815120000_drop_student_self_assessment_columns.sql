-- Drop dead student self-assessment / placement-test columns.
-- Code removed 43737b1; placement test never built; no function, policy,
-- or code reference remained (verified live 15 Aug 2026).
ALTER TABLE public.students DROP COLUMN IF EXISTS self_assessed_level;
ALTER TABLE public.students DROP COLUMN IF EXISTS placement_test_result;
ALTER TABLE public.students DROP COLUMN IF EXISTS placement_test_taken_at;
