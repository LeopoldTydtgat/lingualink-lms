-- Drop the residual index-keyed unique on lesson_annotations.
--
-- PHASE 2 of the attachment_name re-key (phase 1: 20260809120000).
-- Applied live 13 Aug 2026 via the Supabase SQL editor, captured here after.
--
-- Both uniques ran side by side while main's deployed code still upserted on
-- attachment_index. That fix (ad1bb33) is on main and deployed, so every write
-- path now conflicts on (lesson_id, study_sheet_id, attachment_name) and the
-- index-keyed constraint selects nothing.
--
-- While it existed, a file removed or re-uploaded mid-lesson shifted every later
-- attachment by a slot, and the save for the shifted file violated this unique.
-- It failed loudly into not_saving (amber badge, marks requeued) rather than
-- overwriting another file's marks. Fail-safe, but it surfaced to the teacher as
-- a connection fault. Dropping it removes the false alarm.
--
-- attachment_index is still written. It is informational only and keeps its
-- own CHECK (attachment_index >= 0).

ALTER TABLE public.lesson_annotations
  DROP CONSTRAINT IF EXISTS lesson_annotations_unique_pdf;
