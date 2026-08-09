-- Annotation identity moves to attachment NAME (S528).
-- Every read path (serving route, student page, teacher seed) resolves
-- annotations by attachment_name; the write upserted on attachment_index,
-- so an index shift (file removal / same-name re-upload) collided a save
-- onto another file's row and silently overwrote its marks.
--
-- Phase 1 (this migration): attachment_name NOT NULL + name-based unique,
-- added ALONGSIDE the old index constraint because origin/main's deployed
-- code still upserts on the index key. Phase 2 (own DDL session, AFTER this
-- fix is promoted to main and deployed): drop lesson_annotations_unique_pdf.

alter table public.lesson_annotations
  alter column attachment_name set not null;

alter table public.lesson_annotations
  add constraint lesson_annotations_unique_pdf_name
  unique (lesson_id, study_sheet_id, attachment_name);