// src/app/(admin)/admin/reports/page.tsx

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import ReportsClient from './ReportsClient';
import { getMonthToDateRange } from '@/lib/dates/dateRangePresets';
import { localMidnightToUtc } from '@/lib/billing/monthRange';

// Stat-card deep links (/admin/reports?filter=pending|flagged) seed the status
// filter. Anything else falls through to the default "All Statuses".
const FILTER_TO_STATUS: Record<string, string> = {
  pending: 'pending',
  flagged: 'flagged',
};

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; reopen?: string }>
}) {
  // ?reopen=<report id> (the dashboard's flagged-report Reopen button) opens the
  // existing reopen-confirmation modal for that report on load.
  const { filter, reopen } = await searchParams;
  const initialStatusFilter = (filter && FILTER_TO_STATUS[filter]) || '';

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: roleData } = await supabase.rpc('get_user_role');
  if (roleData !== 'admin') redirect('/dashboard');

  // Same source as the admin class-detail page ((admin)/admin/classes/[id]/page.tsx):
  // the logged-in admin's own profiles.timezone, read through the cookie client, falling
  // back to UTC when unset. Report/class times are stored in UTC and formatted client-side
  // with an explicit Intl timeZone, which is deterministic on server and client — no
  // hydration mismatch. A missing profile row must never block the page, so this is a
  // non-fatal read.
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', user.id)
    .maybeSingle();

  // TWO props out of one column, on purpose - they are not interchangeable.
  //
  // adminTimezone keeps the 'UTC' fallback because it feeds Intl formatting, which needs
  // a string; a wrong-but-valid zone still renders a readable timestamp, and there is no
  // "no zone" rendering to fall back to.
  //
  // adminTzRaw keeps the null because it feeds the DateRangeFilter quick-range presets,
  // where UTC is NOT a survivable default: "today"/"this week" resolved in UTC name the
  // wrong calendar day for most of the world, and a filter silently set to the wrong day
  // is worse than one that does not offer presets at all. So the presets go dead on null
  // instead of guessing - the same call this page already makes for the ?filter= seed,
  // and the same one the admin classes page makes for its own ?filter=today.
  const adminTimezone = adminProfile?.timezone ?? 'UTC';
  const adminTzRaw: string | null = adminProfile?.timezone ?? null;

  // Presence of a URL param, not the state it produced - the same test the hasUrlFilters
  // prop at the bottom of this file carries down to the client, hoisted to a const here
  // because the date seed below now reads it too.
  const hasUrlFilters = filter !== undefined || reopen !== undefined;

  // ONE clock read, shared by everything below. Two separate `new Date()` calls either
  // side of a local midnight could let the seeded range and the default that Clear hands
  // back name different days - a narrow window, but the kind this project closes rather
  // than reasons about. The same single-read discipline as the admin classes page.
  const now = new Date();

  // monthToDate is the DEFAULT pair: the range the client's Clear button returns to. It is
  // computed even on a deep link, because Clear must still hand back the landing default
  // there - which is exactly why it travels as its own prop pair, separate from the seed.
  //
  // The SEED pair is what the list OPENS on, and it is EMPTY under ANY URL param.
  // ?reopen= deep-links ONE specific report (the dashboard's flagged-report Reopen button)
  // and ?filter= carries the dashboard card's GLOBAL pending/flagged semantics - so a
  // month-to-date bound could exclude the very rows those links are about, leaving the
  // reopen modal open over a list that does not contain its report, or a "23 pending" card
  // landing on a list of four. A deep link therefore gets no date bound at all.
  //
  // A null timezone seeds nothing through either pair: without a zone there is no honest
  // answer to "which day is today", and naming the wrong month for most of the world is
  // worse than offering no date bound. That is the same call the admin classes page makes,
  // and the same one this page already makes for the DateRangeFilter presets above.
  const monthToDate = adminTzRaw ? getMonthToDateRange(now, adminTzRaw) : { from: '', to: '' };
  const seedDateFrom = hasUrlFilters ? '' : monthToDate.from;
  const seedDateTo   = hasUrlFilters ? '' : monthToDate.to;

  // Query 1: reports + lessons + teacher.
  //
  // MIRRORS the GET route's page-1 query for the SEEDED filter state
  // (src/app/api/admin/reports/route.ts): same select, the same CLASS-date order -
  // lessons(scheduled_at) DESC, with created_at DESC only as the same-instant tiebreaker,
  // and NOT the created_at DESC this query used to carry, which ordered by booking time -
  // same 50 rows, same exact count, the same .eq('status', ...) when ?filter= named one,
  // and - on a plain landing - the same month-to-date bounds on the embedded
  // lessons.scheduled_at, resolved through the same localMidnightToUtc edges over the same
  // !inner embed. That match is what lets the client skip its redundant mount fetch - the
  // rows painted here are the rows that fetch would have returned.

  // The date bounds below select on the EMBEDDED lessons.scheduled_at, and filtering an
  // embedded column on a PLAIN embed only nulls the embed - the parent report row still
  // comes back, so the filter would exclude nothing. !inner is what makes the filter
  // actually drop rows. reports.lesson_id is NOT NULL and admin RLS reads all lessons, so
  // !inner drops nothing else. Applied only when a date bound is live; with none the select
  // string stays byte-identical to the plain-embed version - the route's own reasoning,
  // because this is the route's own query.
  const lessonsEmbed = seedDateFrom ? 'lessons!inner' : 'lessons';

  let query = supabase
    .from('reports')
    .select(`
      id,
      lesson_id,
      teacher_id,
      did_class_happen,
      no_show_type,
      feedback_text,
      status,
      flagged_at,
      completed_at,
      deadline_at,
      created_at,
      ${lessonsEmbed} (
        id,
        scheduled_at,
        duration_minutes,
        status,
        student_id
      ),
      profiles!reports_teacher_id_fkey (
        id,
        full_name,
        photo_url
      )
    `, { count: 'exact' })
    // Ordered by the CLASS date - the joined lessons.scheduled_at rendered in the "Class
    // Date" column - newest class first, with created_at only as the same-instant
    // tiebreaker. created_at alone was wrong for the reason the route spells out: the
    // trg_create_pending_report AFTER INSERT ON lessons trigger writes it when the lesson
    // is BOOKED, not when the class happens. Both .order() calls are TOP level, so this
    // emits the route's exact order param - which is what keeps the MIRRORS claim above
    // true, and with it the client's seed-skip.
    .order('lessons(scheduled_at)', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50);

  // Applied BEFORE the await, on the server. Seeding this list unfiltered and leaving the
  // client's mount fetch to narrow it is what painted the wrong rows for one frame on a
  // /admin/reports?filter=pending deep link.
  if (initialStatusFilter) query = query.eq('status', initialStatusFilter);

  // The month-to-date landing bounds, resolved exactly as the GET route resolves its
  // date_from/date_to: each yyyy-mm-dd names an admin-LOCAL calendar day, turned into a UTC
  // instant by localMidnightToUtc, giving a half-open [from-midnight, midnight-after-to)
  // pair so the To-day is included in full. The bound selects on the CLASS date (the joined
  // lessons.scheduled_at the list renders in its "Class Date" column), never on
  // reports.created_at, which records when the report row was written.
  //
  // Only the timezone branch exists here, unlike the route: these dates are non-empty ONLY
  // when adminTzRaw is set (monthToDate is { from: '', to: '' } without it), so the route's
  // bare-string no-timezone fallback is unreachable on this page. The `&& adminTzRaw` is
  // also what narrows `string | null` to `string` for TypeScript.
  if (seedDateFrom && adminTzRaw) {
    const [y, m, d] = seedDateFrom.split('-').map(Number);
    query = query.gte('lessons.scheduled_at', localMidnightToUtc(y, m, d, adminTzRaw));
  }

  if (seedDateTo && adminTzRaw) {
    const [y, m, d] = seedDateTo.split('-').map(Number);
    // Next calendar day via the Date constructor's own month/year rollover - the same
    // approach the route and getDayRangeInTz use to find their exclusive end edge.
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    query = query.lt(
      'lessons.scheduled_at',
      localMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), adminTzRaw)
    );
  }

  const { data: reportsData, error: reportsError, count: reportsCount } = await query;

  if (reportsError) console.error('Reports seed query error:', reportsError);

  // Collect student_ids
  const studentIds = [
    ...new Set(
      (reportsData ?? [])
        .map((r) => {
          const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons;
          return lesson?.student_id;
        })
        .filter(Boolean) as string[]
    ),
  ];

  // Query 2: students by ID
  const { data: studentsData } = studentIds.length > 0
    ? await supabase
        .from('students')
        .select('id, full_name, photo_url')
        .in('id', studentIds)
    : { data: [] };

  const studentMap = Object.fromEntries(
    (studentsData ?? []).map((s) => [s.id, s])
  );

  // Teacher list for filter dropdown
  const { data: teachersData } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('role', ['teacher', 'admin'])
    .order('full_name');

  // Student list for export filter dropdown
  const { data: allStudentsData } = await supabase
    .from('students')
    .select('id, full_name')
    .order('full_name');

  // Header badge counts. DELIBERATELY global - never scoped by status/teacher_id/date_from/
  // date_to/class_status, so the header shows the real outstanding workload no matter what
  // the client filters the list below down to.
  const [pendingCountRes, flaggedCountRes] = await Promise.all([
    supabase.from('reports').select('id', { count: 'exact', head: true }).in('status', ['pending', 'reopened']),
    supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'flagged'),
  ]);

  if (pendingCountRes.error) console.error('Reports pending count error:', pendingCountRes.error);
  if (flaggedCountRes.error) console.error('Reports flagged count error:', flaggedCountRes.error);

  // Fail-safe: a failed count must never render as 0 and hide work that needs doing, so it
  // falls back to the same predicate over the rows already fetched above - an undercount is
  // recoverable, a silent zero is not.
  const pendingTotal = pendingCountRes.error ? null : pendingCountRes.count;
  const flaggedTotal = flaggedCountRes.error ? null : flaggedCountRes.count;

  const initialPendingCount = pendingTotal
    ?? (reportsData ?? []).filter((r) => r.status === 'pending' || r.status === 'reopened').length;
  const initialFlaggedCount = flaggedTotal
    ?? (reportsData ?? []).filter((r) => r.status === 'flagged').length;

  // null means "seed unusable - the client must run its mount fetch". This is the single
  // flag that disables the client-side skip, so a failed seed still self-heals through the
  // existing fetch path instead of rendering an empty list as truth. Computed HERE, below
  // the counts, because the second arm reads their error state.
  //
  // That second arm protects the two fallbacks directly above. They are only honest over an
  // UNFILTERED seed: with ?filter=flagged the seed holds flagged rows alone, so the pending
  // fallback derives 0 from rows that could never contain a pending report - and with the
  // mount fetch skipped, nothing would ever correct it. A month-to-date seed is the SAME
  // hazard on a different axis: it excludes an out-of-month pending or flagged report
  // exactly as a status-filtered seed excludes another status, so the derived badge would
  // undercount the outstanding workload the header exists to report. So a failed global
  // count over EITHER kind of filtered seed forces that fetch, and the route's own counts
  // repair the badges. A seed with neither filter keeps the existing fallback exactly, and
  // both counts succeeding leaves every load unchanged - the fallbacks are unused and the
  // skip stands.
  const initialTotal: number | null =
    reportsError ? null
    : (initialStatusFilter || seedDateFrom) && (pendingCountRes.error || flaggedCountRes.error) ? null
    : (reportsCount ?? 0);

  const initialReports = (reportsData ?? []).map((r) => {
    const lesson  = Array.isArray(r.lessons)  ? r.lessons[0]  : r.lessons;
    const teacher = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    const student = lesson?.student_id ? studentMap[lesson.student_id] ?? null : null;

    return {
      id:               r.id,
      lesson_id:        r.lesson_id,
      status:           r.status,
      did_class_happen: r.did_class_happen,
      no_show_type:     r.no_show_type,
      feedback_text:    r.feedback_text,
      flagged_at:       r.flagged_at,
      completed_at:     r.completed_at,
      deadline_at:      r.deadline_at,
      created_at:       r.created_at,
      lesson: lesson ? {
        id:               lesson.id,
        scheduled_at:     lesson.scheduled_at,
        duration_minutes: lesson.duration_minutes,
        status:           lesson.status,
      } : null,
      teacher: teacher ? {
        id:        teacher.id,
        full_name: teacher.full_name,
        photo_url: teacher.photo_url,
      } : null,
      student: student ? {
        id:        student.id,
        full_name: student.full_name,
        photo_url: student.photo_url,
      } : null,
    };
  });

  return (
    <ReportsClient
      initialReports={initialReports}
      teachers={teachersData ?? []}
      students={allStudentsData ?? []}
      initialStatusFilter={initialStatusFilter}
      initialReopenId={reopen}
      adminTimezone={adminTimezone}
      adminTzRaw={adminTzRaw}
      initialPendingCount={initialPendingCount}
      initialFlaggedCount={initialFlaggedCount}
      initialTotal={initialTotal}
      // The range the list OPENS on: month-to-date on a plain landing, '' under any URL
      // param or a timezone-less profile. '' means no date bound - all history.
      initialDateFrom={seedDateFrom}
      initialDateTo={seedDateTo}
      // The LANDING default, which the client's Clear button returns to. A separate pair
      // because it and the two above DISAGREE under a deep link: ?filter= / ?reopen= open
      // on no date bound at all, but Clear must hand back the month-to-date view rather
      // than the deep link's. Equal to the seed pair on every plain landing, and '' for
      // both on a timezone-less profile - where Clear empties the inputs as it always did.
      defaultDateFrom={monthToDate.from}
      defaultDateTo={monthToDate.to}
      // Presence of a URL param, not the state it produced: an unrecognised ?filter=
      // value still yields an empty initialStatusFilter, and that empty result IS the
      // URL's answer - the client must honour it rather than restoring a remembered
      // filter over the top.
      //
      // ?reopen= counts too, even though it seeds no filter at all: it deep-links ONE
      // specific report (the dashboard's flagged-report Reopen button), and a remembered
      // status/teacher/date filter could easily exclude that very row - leaving the
      // confirmation modal open over a list that does not contain the report it is about.
      // A deep link gets the clean default list.
      //
      // A URL param also suppresses the month-to-date seed entirely - the list lands with
      // both date inputs empty - for the reason spelled out at the seed block above.
      hasUrlFilters={hasUrlFilters}
    />
  );
}
