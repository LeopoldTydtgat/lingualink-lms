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
    />
  );
}
