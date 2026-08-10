-- S483: reports.student_confirmed must never be fabricated by a default.
-- The attestation is a fraud control: it must be actively given by the
-- teacher. Both insert paths (pending-report trigger and
-- createPendingReport.ts) omit the column, so the old DEFAULT true made
-- every fresh report render the checkbox pre-checked, defeating
-- ReportFormClient's `?? false` fail-safe. NULL = not yet answered.

ALTER TABLE reports ALTER COLUMN student_confirmed DROP DEFAULT;

-- Backfill: clear the fabricated true on never-filed reports only.
-- did_class_happen IS NULL = never answered; verified this cannot touch
-- reopened or completed rows, which hold genuine saved values.
UPDATE reports
SET student_confirmed = NULL
WHERE did_class_happen IS NULL;
