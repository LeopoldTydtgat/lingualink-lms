// src/app/api/admin/reports/route.ts

import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const { data: roleData } = await supabase.rpc('get_user_role');
  if (roleData !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const page        = parseInt(searchParams.get('page')  ?? '1');
  const limit       = parseInt(searchParams.get('limit') ?? '50');
  const status      = searchParams.get('status');
  const teacherId   = searchParams.get('teacher_id');
  const dateFrom    = searchParams.get('date_from');
  const dateTo      = searchParams.get('date_to');
  const classStatus = searchParams.get('class_status');

  const from = (page - 1) * limit;
  const to   = from + limit - 1;

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
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status)    query = query.eq('status', status);
  if (teacherId) query = query.eq('teacher_id', teacherId);
  if (dateFrom)  query = query.gte('created_at', `${dateFrom}T00:00:00`);
  if (dateTo)    query = query.lte('created_at', `${dateTo}T23:59:59`);
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

  return NextResponse.json({ reports, total: count ?? 0, page, limit });
}
