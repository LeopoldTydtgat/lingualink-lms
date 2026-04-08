// src/app/api/admin/reports/live-trace/route.ts

import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const { data: roleData } = await supabase.rpc('get_user_role');
  if (roleData !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Query 1: lessons + teacher + report
  const { data, error } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teacher_id,
      student_id,
      profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url
      ),
      reports (
        id,
        status,
        did_class_happen,
        completed_at,
        flagged_at
      )
    `)
    .order('scheduled_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Live trace GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Collect student_ids
  const studentIds = [
    ...new Set(
      (data ?? []).map((l) => l.student_id).filter(Boolean) as string[]
    ),
  ];

  // Query 2: students by ID
  const { data: studentsData } = studentIds.length > 0
    ? await supabase
        .from('students')
        .select('id, full_name')
        .in('id', studentIds)
    : { data: [] };

  const studentMap = Object.fromEntries(
    (studentsData ?? []).map((s) => [s.id, s])
  );

  const lessons = (data ?? []).map((lesson) => {
    const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles;
    const report  = Array.isArray(lesson.reports)  ? lesson.reports[0]  : lesson.reports;
    const student = lesson.student_id ? studentMap[lesson.student_id] ?? null : null;

    return {
      id:               lesson.id,
      scheduled_at:     lesson.scheduled_at,
      duration_minutes: lesson.duration_minutes,
      lesson_status:    lesson.status,
      teacher: teacher ? { id: teacher.id, full_name: teacher.full_name, photo_url: teacher.photo_url } : null,
      student: student ? { id: student.id,  full_name: student.full_name } : null,
      report:  report  ? { id: report.id, status: report.status, did_class_happen: report.did_class_happen, completed_at: report.completed_at, flagged_at: report.flagged_at } : null,
    };
  });

  return NextResponse.json({ lessons });
}
