// src/app/(admin)/admin/reports/[id]/page.tsx

import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import ReportDetailClient from './ReportDetailClient';

export default async function AdminReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const { id }   = await params;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: roleData } = await supabase.rpc('get_user_role');
  if (roleData !== 'admin') redirect('/dashboard');

  // Same source as the reports list page ((admin)/admin/reports/page.tsx): the logged-in
  // admin's own profiles.timezone, read through the cookie client, falling back to UTC when
  // unset. Report/class times are stored in UTC and formatted client-side with an explicit
  // Intl timeZone, which is deterministic on server and client — no hydration mismatch.
  // A missing profile row must never block the page, so this is a non-fatal read.
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', user.id)
    .maybeSingle();

  const adminTimezone = adminProfile?.timezone ?? 'UTC';

  const { data: report, error } = await supabase
    .from('reports')
    .select(`
      id,
      lesson_id,
      teacher_id,
      did_class_happen,
      no_show_type,
      feedback_text,
      additional_details,
      level_data,
      status,
      flagged_at,
      completed_at,
      deadline_at,
      created_at,
      updated_at,
      student_confirmed,
      impersonation_note,
      lessons (
        id,
        scheduled_at,
        duration_minutes,
        status,
        teams_join_url,
        student_id
      ),
      profiles!reports_teacher_id_fkey (
        id,
        full_name,
        photo_url
      )
    `)
    .eq('id', id)
    .single();

  if (error || !report) notFound();

  const lesson  = Array.isArray(report.lessons)  ? report.lessons[0]  : report.lessons;
  const teacher = Array.isArray(report.profiles) ? report.profiles[0] : report.profiles;

  let student = null;
  if (lesson?.student_id) {
    const { data: s } = await supabase
      .from('students')
      .select('id, full_name, photo_url')
      .eq('id', lesson.student_id)
      .single();
    student = s;
  }

  const { data: assignments } = await supabase
    .from('assignments')
    .select(`
      id,
      assigned_at,
      study_sheets (
        id,
        title,
        category,
        level
      )
    `)
    .eq('report_id', id);

  const flatAssignments = (assignments ?? []).map((a) => {
    const sheet = Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets;
    return {
      id:          a.id,
      assigned_at: a.assigned_at,
      sheet: sheet ? { id: sheet.id, title: sheet.title, category: sheet.category, level: sheet.level } : null,
    };
  });

  return (
    <ReportDetailClient
      report={{
        id:                 report.id,
        lesson_id:          report.lesson_id,
        status:             report.status,
        did_class_happen:   report.did_class_happen,
        no_show_type:       report.no_show_type,
        feedback_text:      report.feedback_text,
        additional_details: report.additional_details,
        level_data:         report.level_data,
        flagged_at:         report.flagged_at,
        completed_at:       report.completed_at,
        deadline_at:        report.deadline_at,
        created_at:         report.created_at,
        impersonation_note: report.impersonation_note,
        lesson: lesson ? {
          id:               lesson.id,
          scheduled_at:     lesson.scheduled_at,
          duration_minutes: lesson.duration_minutes,
          status:           lesson.status,
          teams_join_url:   lesson.teams_join_url,
        } : null,
        teacher: teacher ? { id: teacher.id, full_name: teacher.full_name, photo_url: teacher.photo_url } : null,
        student: student  ? { id: student.id,  full_name: student.full_name,  photo_url: student.photo_url  } : null,
      }}
      assignments={flatAssignments}
      adminTimezone={adminTimezone}
    />
  );
}
