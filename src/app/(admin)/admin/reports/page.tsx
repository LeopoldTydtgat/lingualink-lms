// src/app/(admin)/admin/reports/page.tsx

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import ReportsClient from './ReportsClient';

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

  // Query 1: reports + lessons + teacher
  const { data: reportsData } = await supabase
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
      lessons (
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
    `)
    .order('created_at', { ascending: false })
    .limit(50);

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
      hasUrlFilters={filter !== undefined || reopen !== undefined}
    />
  );
}
