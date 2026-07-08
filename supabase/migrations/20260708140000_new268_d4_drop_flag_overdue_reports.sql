-- NEW268 D4: remove rogue duplicate flagger (applied live 8 Jul 2026)
-- pg_cron ran flag_overdue_reports() every 15 min. It flagged reports
-- WITHOUT stamping lessons.status = 'missed', and by flagging first it
-- hid those reports from the JS cron (/api/cron/report-overdue), which
-- is the complete implementation (flag + 'missed' stamp + email).
-- The JS route (vercel.json, daily 08:00) is now the single flagging path.
-- No data repair needed: zero flagged reports existed at removal time.

select cron.unschedule(jobid)
from cron.job
where command like '%flag_overdue_reports%';

drop function if exists public.flag_overdue_reports();
