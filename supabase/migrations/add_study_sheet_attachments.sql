-- Migration: add attachments column to study_sheets
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- Stores file attachment metadata as a JSON array:
-- [{ "name": "filename.pdf", "url": "https://...", "type": "application/pdf" }]
--
-- Also requires a Supabase Storage bucket named 'library-files' (public read).
-- Create it in the Supabase dashboard under Storage > New bucket > library-files.

ALTER TABLE study_sheets
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
