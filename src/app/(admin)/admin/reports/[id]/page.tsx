// src/app/(admin)/admin/reports/[id]/page.tsx

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect, notFound } from 'next/navigation';
import ReportDetailClient from './ReportDetailClient';

// Mirrors the `assignments` prop of ReportDetailClient exactly — the sheet fields stay
// non-nullable (only the whole sheet is nullable), so the prop type needs no widening.
type FlatAssignment = {
  id:          string;
  assigned_at: string;
  sheet:       { id: string; title: string; category: string | null; level: string | null } | null;
};

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

  // SERVICE-ROLE ON PURPOSE — do not "fix" this back to the cookie client.
  // `assignments` has no report_id column, so the row is keyed on the report's own
  // lesson_id. It also has RLS on with NO admin SELECT policy: the only SELECT policies
  // are "Students read own assignments" and "Teachers can view assignments" (scoped through
  // trainings), so the RLS client returns zero rows for every student who is not the
  // logged-in admin. This page is already admin-gated above (get_user_role === 'admin'),
  // which is what authorises the bypass. Two-step read (ids, then sheets) — the PostgREST
  // embed form has never executed successfully in this codebase.
  // A failed read is logged and degrades to an empty list; it must never blank the report.
  const admin = createAdminClient();
  const flatAssignments: FlatAssignment[] = [];

  // No lesson_id means nothing to key on. Skip both queries — an empty string against a
  // uuid column is a 400, not an empty result.
  if (report.lesson_id) {
    const { data: assignmentRows, error: assignmentsError } = await admin
      .from('assignments')
      .select('id, assigned_at, study_sheet_id')
      .eq('lesson_id', report.lesson_id)
      .order('assigned_at', { ascending: true });

    if (assignmentsError) {
      console.error(
        `Admin report detail: assignments read failed (report ${id}, lesson ${report.lesson_id}):`,
        assignmentsError.message
      );
    }

    const rows = assignmentRows ?? [];
    const sheetIds = [...new Set(
      rows.map((a) => a.study_sheet_id).filter((sid): sid is string => !!sid)
    )];

    const sheetById = new Map<string, NonNullable<FlatAssignment['sheet']>>();
    if (sheetIds.length > 0) {
      const { data: sheetRows, error: sheetsError } = await admin
        .from('study_sheets')
        .select('id, title, category, level')
        .in('id', sheetIds);

      if (sheetsError) {
        console.error(
          `Admin report detail: study_sheets lookup failed (report ${id}, lesson ${report.lesson_id}):`,
          sheetsError.message
        );
      }

      for (const s of sheetRows ?? []) {
        sheetById.set(s.id, { id: s.id, title: s.title, category: s.category, level: s.level });
      }
    }

    for (const a of rows) {
      flatAssignments.push({
        id:          a.id,
        assigned_at: a.assigned_at,
        sheet:       (a.study_sheet_id ? sheetById.get(a.study_sheet_id) : undefined) ?? null,
      });
    }
  }

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
