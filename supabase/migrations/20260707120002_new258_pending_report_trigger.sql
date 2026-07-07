-- NEW258 - guarantee every 'scheduled' lesson gets its paired 'pending' report
-- row at the DB level, closing the gap where a killed booking request committed
-- the lesson but never wrote the report (immortal 'scheduled' zombie, invisible
-- to the report-overdue cron, counted at full projected pay). An AFTER INSERT
-- trigger on lessons inserts the pending report in the same transaction as the
-- lesson, so the two can never diverge. ON CONFLICT (lesson_id) DO NOTHING makes
-- it a no-op when the booking route's own createPendingReport already wrote it.
--
-- Applied live via the Supabase SQL Editor on 07 Jul 2026 BEFORE this migration
-- file was written; this file is the repo catch-up record.

CREATE OR REPLACE FUNCTION public.create_pending_report_on_lesson_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'scheduled' THEN
    INSERT INTO reports (lesson_id, teacher_id, status, deadline_at)
    VALUES (
      NEW.id,
      NEW.teacher_id,
      'pending',
      NEW.scheduled_at + (NEW.duration_minutes * interval '1 minute') + interval '12 hours'
    )
    ON CONFLICT (lesson_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_create_pending_report ON public.lessons;

CREATE TRIGGER trg_create_pending_report
  AFTER INSERT ON public.lessons
  FOR EACH ROW
  EXECUTE FUNCTION public.create_pending_report_on_lesson_insert();

REVOKE EXECUTE ON FUNCTION public.create_pending_report_on_lesson_insert()
  FROM anon, authenticated, public;
