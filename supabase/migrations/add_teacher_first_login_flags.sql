-- Migration: add first-login flags to profiles (teachers)
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- Mirrors the must_change_password / profile_completed columns that already
-- exist on the students table, giving teachers the same first-login flow.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_completed    boolean NOT NULL DEFAULT false;
