// src/app/api/admin/reports/route.ts

import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { localMidnightToUtc } from '@/lib/billing/monthRange';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // requireAdmin() returns the auth User, and profiles.id IS the auth uuid for staff -
  // the same lookup the admin classes GET does to resolve its date edges.
  const { data: profile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', user.id)
    .maybeSingle();

  const adminTz: string | null = profile?.timezone ?? null;

  const { searchParams } = new URL(request.url);

  // Absent, non-numeric ('abc'), zero and negative values all fall back to the defaults
  // rather than producing a NaN / inverted PostgREST range. limit is capped at 100 so a
  // hand-crafted ?limit= cannot pull the whole table in one request.
  const rawPage  = parseInt(searchParams.get('page')  ?? '', 10);
  const rawLimit = parseInt(searchParams.get('limit') ?? '', 10);
  const page        = Number.isInteger(rawPage)  && rawPage  >= 1 ? rawPage : 1;
  const limit       = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 100) : 50;
  const status      = searchParams.get('status');
  const teacherId   = searchParams.get('teacher_id');
  const dateFrom    = searchParams.get('date_from');   // yyyy-mm-dd calendar day, admin-local
  const dateTo      = searchParams.get('date_to');     // yyyy-mm-dd calendar day, admin-local (inclusive)
  const classStatus = searchParams.get('class_status');

  const from = (page - 1) * limit;
  const to   = from + limit - 1;

  // A malformed date param is IGNORED (no filter applied) and never reaches PostgREST -
  // the same day-key guard the admin classes GET applies.
  const isDateKey = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const applyDateFrom = !!dateFrom && isDateKey(dateFrom);
  const applyDateTo   = !!dateTo   && isDateKey(dateTo);

  // The date filters below select on the EMBEDDED lessons.scheduled_at, and filtering an
  // embedded column on a PLAIN embed only nulls the embed - the parent report row still
  // comes back, so the filter would exclude nothing. !inner is what makes the filter
  // actually drop rows. reports.lesson_id is NOT NULL and admin RLS reads all lessons, so
  // !inner drops nothing else. Applied only when a date filter is live; with no date
  // filter the select string stays byte-identical to the plain-embed version.
  const lessonsEmbed = applyDateFrom || applyDateTo ? 'lessons!inner' : 'lessons';

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
    // Ordered by the CLASS date - the joined lessons.scheduled_at this list renders in its
    // "Class Date" column - newest class first. created_at is the WRONG key on its own:
    // report rows are written by the trg_create_pending_report AFTER INSERT ON lessons
    // trigger, so created_at records when the lesson was BOOKED, not when the class
    // happened - a list showing class dates came back in booking order, which looks
    // random. created_at survives only as the tiebreaker for two classes at the same
    // instant, which keeps range() pagination deterministic across pages.
    //
    // Both .order() calls are TOP level (no referencedTable on either), so postgrest-js
    // emits a single order param: order=lessons(scheduled_at).desc,created_at.desc -
    // PostgREST's documented to-one embedded sort syntax. It needs no !inner, so the
    // lessonsEmbed conditional above is deliberately left alone.
    .order('lessons(scheduled_at)', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status)    query = query.eq('status', status);
  if (teacherId) query = query.eq('teacher_id', teacherId);

  // The date filters name calendar DAYS in the admin's own timezone and select on the
  // CLASS date - the joined lessons.scheduled_at that the list renders in its "Class Date"
  // column - not reports.created_at, which records when the report row was written. The
  // previous created_at filter compared offset-less naive timestamps, so it bucketed by
  // booking time in whatever zone Postgres resolved them to, never by class day.
  // scheduled_at is a UTC instant, so each edge resolves through localMidnightToUtc - the
  // same helper the admin classes GET filter uses - into a half-open
  // [from-midnight, midnight-after-to) instant pair, so the To-day is fully included.
  // Fail-safe: with no timezone on the profile there is no local day to resolve, so the
  // bare-string comparison stands unchanged rather than guessing UTC - the same
  // no-timezone fallback the classes route uses.
  if (applyDateFrom) {
    if (adminTz) {
      const [y, m, d] = dateFrom!.split('-').map(Number);
      query = query.gte('lessons.scheduled_at', localMidnightToUtc(y, m, d, adminTz));
    } else {
      query = query.gte('lessons.scheduled_at', dateFrom!);
    }
  }

  if (applyDateTo) {
    if (adminTz) {
      const [y, m, d] = dateTo!.split('-').map(Number);
      // Next calendar day via the Date constructor's own month/year rollover - the same
      // approach getDayRangeInTz uses to find its exclusive end edge.
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      query = query.lt(
        'lessons.scheduled_at',
        localMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), adminTz)
      );
    } else {
      query = query.lte('lessons.scheduled_at', dateTo!);
    }
  }

  if (classStatus) {
    if (classStatus === 'taken')                query = query.eq('did_class_happen', true);
    else if (classStatus === 'student_no_show') query = query.eq('no_show_type', 'student');
    else if (classStatus === 'teacher_no_show') query = query.eq('no_show_type', 'teacher');
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Reports GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const studentIds = [
    ...new Set(
      (data ?? [])
        .map((r) => {
          const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons;
          return lesson?.student_id;
        })
        .filter(Boolean) as string[]
    ),
  ];

  const { data: studentsData } = studentIds.length > 0
    ? await supabase
        .from('students')
        .select('id, full_name, photo_url')
        .in('id', studentIds)
    : { data: [] };

  const studentMap = Object.fromEntries(
    (studentsData ?? []).map((s) => [s.id, s])
  );

  const reports = (data ?? []).map((r) => {
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

  // Header badge counts. DELIBERATELY global - never scoped by status/teacher_id/date_from/
  // date_to/class_status, so the header keeps showing the real outstanding workload while the
  // list below is filtered. Do not "fix" this by applying the filters above.
  const [pendingCountRes, flaggedCountRes] = await Promise.all([
    supabase.from('reports').select('id', { count: 'exact', head: true }).in('status', ['pending', 'reopened']),
    supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'flagged'),
  ]);

  // A failed badge count must never take down the reports list - it degrades to null.
  if (pendingCountRes.error) console.error('Reports pending count error:', pendingCountRes.error);
  if (flaggedCountRes.error) console.error('Reports flagged count error:', flaggedCountRes.error);

  const pendingTotal = pendingCountRes.error ? null : pendingCountRes.count;
  const flaggedTotal = flaggedCountRes.error ? null : flaggedCountRes.count;

  return NextResponse.json({
    reports,
    total: count ?? 0,
    page,
    limit,
    pendingTotal: pendingTotal ?? null,
    flaggedTotal: flaggedTotal ?? null,
  });
}
