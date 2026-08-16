// src/app/api/admin/reports/[id]/route.ts

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { NextRequest, NextResponse } from 'next/server';

// Shape of each entry in the `assignments` key of the GET response. Byte-identical to what
// this route has always returned, and to the ReportDetailClient prop the page feeds.
type FlatAssignment = {
  id:          string;
  assigned_at: string;
  sheet:       { id: string; title: string; category: string | null; level: string | null } | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { id } = await params;

  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  if (error) {
    console.error('Report detail GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
  // `assignments` has no report_id column, so the rows are keyed on the report's own
  // lesson_id. It also has RLS on with NO admin SELECT policy: the only SELECT policies
  // are "Students read own assignments" and "Teachers can view assignments" (scoped through
  // trainings), so the RLS client returns zero rows for every student who is not the
  // requesting admin. This handler is already admin-gated by requireAdmin() above, which is
  // what authorises the bypass. Two-step read (ids, then sheets) — the PostgREST embed form
  // has never executed successfully in this codebase.
  // A failed read is logged and degrades to an empty list; the status contract is unchanged,
  // so the rest of the report is still returned 200.
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
        `Report detail GET: assignments read failed (report ${id}, lesson ${report.lesson_id}):`,
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
          `Report detail GET: study_sheets lookup failed (report ${id}, lesson ${report.lesson_id}):`,
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

  return NextResponse.json({
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
    updated_at:         report.updated_at,
    student_confirmed:  report.student_confirmed,
    impersonation_note: report.impersonation_note,
    lesson: lesson ? {
      id:               lesson.id,
      scheduled_at:     lesson.scheduled_at,
      duration_minutes: lesson.duration_minutes,
      status:           lesson.status,
      teams_join_url:   lesson.teams_join_url,
    } : null,
    teacher: teacher ? { id: teacher.id, full_name: teacher.full_name, photo_url: teacher.photo_url } : null,
    student,
    assignments: flatAssignments,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { id } = await params;

  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (body.action !== 'reopen') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from('reports')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  if (existing.status !== 'flagged' && existing.status !== 'completed') {
    return NextResponse.json({ error: 'Only flagged or completed reports can be reopened' }, { status: 400 });
  }

  // Reopenable statuses: 'flagged' (never submitted) and 'completed' (submitted
  // but wrong - the admin correction path). completed_at is cleared so a reopened
  // report carries no stale submitted timestamp; complete_report_atomic stamps it
  // fresh when the teacher re-files.
  // The status predicate guards the race between the check above and this
  // write; .select confirms a row was actually touched — zero rows means the
  // status changed underneath us (or the write silently matched nothing).
  const { data: updatedRows, error } = await supabase
    .from('reports')
    .update({ status: 'reopened', flagged_at: null, completed_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['flagged', 'completed'])
    .select('id');

  if (error) {
    console.error('Report reopen PATCH error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json({ error: 'Report can no longer be reopened. Refresh and try again.' }, { status: 409 });
  }

  return NextResponse.json({ success: true });
}
