-- Migration: RLS policies for the availability table
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- The availability API routes now use the service-role admin client for writes,
-- so these policies are not strictly required for the current code to work.
-- They are included here as the correct long-term security posture so that any
-- future direct queries (e.g. from the student availability route) are also safe.

ALTER TABLE availability ENABLE ROW LEVEL SECURITY;

-- Teachers can read their own rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'availability' AND policyname = 'Teachers can view own availability'
  ) THEN
    CREATE POLICY "Teachers can view own availability"
      ON availability FOR SELECT
      TO authenticated
      USING (teacher_id = auth.uid());
  END IF;
END $$;

-- Teachers can insert their own rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'availability' AND policyname = 'Teachers can insert own availability'
  ) THEN
    CREATE POLICY "Teachers can insert own availability"
      ON availability FOR INSERT
      TO authenticated
      WITH CHECK (teacher_id = auth.uid());
  END IF;
END $$;

-- Teachers can delete their own rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'availability' AND policyname = 'Teachers can delete own availability'
  ) THEN
    CREATE POLICY "Teachers can delete own availability"
      ON availability FOR DELETE
      TO authenticated
      USING (teacher_id = auth.uid());
  END IF;
END $$;
