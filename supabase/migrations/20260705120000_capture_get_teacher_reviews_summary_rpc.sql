-- Migration: capture get_teacher_reviews_summary RPC
-- Date: 2026-07-05
--
-- This SECURITY DEFINER function was created directly in the Supabase SQL editor
-- to power anonymised teacher review summaries on the student booking page. It is
-- already live and verified (definer, search_path pinned to '', EXECUTE revoked
-- from public and anon, granted to authenticated). This migration is a VERBATIM
-- capture of the live definition so the repo matches production and a from-scratch
-- replay reproduces the current state.
--
-- It is a no-op against the live database: CREATE OR REPLACE of a byte-identical
-- body, and the grants are already in place. Do not edit the body here to
-- "improve" it - it is ground truth as of 2026-07-05. Any future change starts
-- from this file.
--
-- What it exposes: for each teacher id passed in, an aggregate rating (avg,
-- rounded to 1dp), a total review count, and up to 5 recent reviews as
-- {rating, text, submitted_at}. The review text prefers the admin-edited text and
-- falls back to the original. NO student identity (student_id, names, class_id) is
-- ever returned - the definer boundary lets a student read anonymised aggregates
-- for teachers without exposing who wrote each review or their own-reviews-only
-- RLS being widened.

create or replace function public.get_teacher_reviews_summary(p_teacher_ids uuid[])
returns table (
  teacher_id uuid,
  avg_rating numeric,
  review_count integer,
  recent_reviews jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.tid,
    round(avg(sr.rating)::numeric, 1),
    count(sr.id)::integer,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'rating', r.rating,
                   'text', r.display_text,
                   'submitted_at', r.submitted_at
                 )
                 order by r.submitted_at desc
               )
        from (
          select
            sr2.rating,
            coalesce(nullif(sr2.admin_edited_text, ''), sr2.review_text) as display_text,
            sr2.submitted_at
          from public.student_reviews sr2
          where sr2.teacher_id = t.tid
            and coalesce(nullif(sr2.admin_edited_text, ''), sr2.review_text) is not null
          order by sr2.submitted_at desc
          limit 5
        ) r
      ),
      '[]'::jsonb
    )
  from unnest(p_teacher_ids) as t(tid)
  left join public.student_reviews sr on sr.teacher_id = t.tid
  group by t.tid;
$$;

revoke all on function public.get_teacher_reviews_summary(uuid[]) from public;
revoke execute on function public.get_teacher_reviews_summary(uuid[]) from anon;
grant execute on function public.get_teacher_reviews_summary(uuid[]) to authenticated;
