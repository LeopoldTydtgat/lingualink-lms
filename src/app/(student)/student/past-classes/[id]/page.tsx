import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect, notFound } from 'next/navigation';
import PastClassDetailClient from './PastClassDetailClient';
import { requireTz } from '@/lib/time/requireTz';
import { STUDENT_PAST_LESSON_STATUSES } from '@/lib/billing/billability';
import type { Annotation } from '@/components/pdf/PdfViewer';

// Shape handed to PastClassDetailClient as `lesson.report`. Kept in sync with the
// client's own Report interface - the select list below must cover exactly these
// fields and nothing else.
type StudentVisibleReport = {
  id: string;
  feedback_text: string | null;
  did_class_happen: boolean | null;
  level_data: Record<string, string> | null;
};

// Minimal shape of a study_sheets.attachments entry - only the field the display
// filter below needs. attachments is jsonb, so nothing about it is guaranteed at
// runtime; the resolver re-checks the name exactly as the serving route does.
// Deliberately declared here rather than imported from the route file (route
// modules export handlers only).
type SheetAttachment = { name: string };

// Mirrors the attachment-resolution block in
// /api/lesson-annotation-file/[lessonId]/[sheetId]/[index]/route.ts EXACTLY:
//   - a non-empty attachment_name resolves by NAME against the sheet's current
//     attachments and never falls back to position;
//   - a null/empty attachment_name (legacy rows) falls back to
//     attachments[attachment_index];
//   - either way the resolved entry must exist and its filename must pass the
//     route's charset check.
// Anything this returns false for is a guaranteed 404 from that route.
function attachmentResolves(
  attachments: SheetAttachment[],
  attachmentName: unknown,
  attachmentIndex: number
): boolean {
  const attachment =
    typeof attachmentName === 'string' && attachmentName.length > 0
      ? attachments.find((a) => a && a.name === attachmentName)
      : attachments[attachmentIndex];

  return (
    !!attachment &&
    typeof attachment.name === 'string' &&
    /^[a-zA-Z0-9._-]+$/.test(attachment.name)
  );
}

export default async function PastClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/student/login');

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, timezone, profile_completed')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (!student) redirect('/student/login');

  if (student.profile_completed !== true) {
    redirect('/student/account?confirm_tz=1');
  }

  // Fetch the lesson — confirm it belongs to this student.
  // This RLS-bound query is the ownership gate for the report read below; the
  // report is NOT embedded here.
  const { data: lesson } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teacher:profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url,
        bio
      )
    `)
    .eq('id', id)
    .eq('student_id', student.id)
    .maybeSingle();

  if (!lesson) notFound();

  // Student-visible-past gate, identical to the list page's: a settled history
  // status, OR a 'scheduled' lesson whose END instant has passed (the class
  // happened, the teacher's report just is not in yet). Ownership alone used to
  // be the only gate here, so a direct URL reached a future or in-progress class
  // and every excluded status ('missed', every cancellation) too - this closes
  // all of those. This is a UTC INSTANT comparison against a timestamptz, not
  // local calendar-date construction - which is what the repo's toISOString ban
  // covers. `new Date().getTime()` rather than Date.now() because the
  // react-hooks/purity rule (React Compiler, via eslint-config-next) mis-fires
  // on Date.now() in async Server Components; same instant either way.
  const nowMs = new Date().getTime();
  const lessonEndMs =
    new Date(lesson.scheduled_at as string).getTime() +
    (lesson.duration_minutes as number) * 60000;
  const isStudentVisiblePast =
    (STUDENT_PAST_LESSON_STATUSES as readonly string[]).includes(lesson.status as string) ||
    (lesson.status === 'scheduled' && lessonEndMs <= nowMs);

  if (!isStudentVisiblePast) notFound();

  // public.reports has RLS policies for teachers and admins only - there is no
  // student SELECT policy, and that is deliberate: a student policy would expose
  // the whole row including student_confirmed and impersonation_note (a fraud flag
  // the teacher writes ABOUT the student), and column-level REVOKE cannot separate
  // students from teachers because both share the `authenticated` role.
  // So read the safe columns server-side through the service-role client, exactly
  // as (dashboard)/account/page.tsx reads student_reviews. Ownership was already
  // established by the RLS-bound lesson query above, which returns a row only when
  // this lesson is this student's - reaching this line IS the security boundary,
  // because the admin client bypasses RLS. Never widen this select list.
  // additional_details is deliberately absent: it is the teacher's admin-facing
  // account of the class (required on a no-show) and is read only by admin and
  // by whichever teacher currently owns the report row.
  // reports has a UNIQUE constraint on lesson_id, so maybeSingle() is exact.
  const admin = createAdminClient();
  const { data: reportRow, error: reportError } = await admin
    .from('reports')
    .select('id, feedback_text, did_class_happen, level_data')
    .eq('lesson_id', id)
    .maybeSingle();

  if (reportError) {
    // Fail soft: the page still renders with the no-feedback placeholder.
    console.error('[student/past-classes/[id]] report fetch failed:', reportError);
  }

  const report: StudentVisibleReport | null = reportRow
    ? {
        id: reportRow.id as string,
        feedback_text: (reportRow.feedback_text ?? null) as string | null,
        did_class_happen: (reportRow.did_class_happen ?? null) as boolean | null,
        level_data: (reportRow.level_data ?? null) as Record<string, string> | null,
      }
    : null;

  // Fetch assignments for this lesson (study sheets the teacher assigned)
  const { data: assignments } = await supabase
    .from('assignments')
    .select(`
      id,
      study_sheet:study_sheets (
        id,
        title,
        category,
        level
      )
    `)
    .eq('lesson_id', id);

  // Check if student has already reviewed this class
  const { data: existingReview } = await supabase
    .from('student_reviews')
    .select('id, rating, review_text')
    .eq('class_id', id)
    .eq('student_id', student.id)
    .maybeSingle();

  // Fetch the teacher's marked-up PDFs for this lesson. The RLS policy
  // "Students read final lesson annotations after cutoff" returns rows ONLY when
  // this is the student's own lesson AND the 15-minute post-class cutoff has
  // passed — so this user-scoped query IS the access gate. No ownership or cutoff
  // logic is re-derived here, and the service-role client is never used on this path.
  // attachment_name is selected purely to mirror the serving route's attachment
  // resolution below; it is never handed to the client.
  const { data: annotatedRows } = await supabase
    .from('lesson_annotations')
    .select('study_sheet_id, attachment_index, attachment_name, annotations')
    .eq('lesson_id', id)
    .order('study_sheet_id', { ascending: true })
    .order('attachment_index', { ascending: true });

  // Only rows that actually carry marks are candidates for a viewer.
  const markedRows = (annotatedRows ?? []).filter(
    (r) => Array.isArray(r.annotations) && r.annotations.length > 0
  );

  // Resolve which of those rows the file route can still serve.
  // /api/lesson-annotation-file returns 404 for every byte request in TWO cases:
  // the sheet's is_active !== true, and the annotated attachment no longer
  // resolving on that sheet (removed, renamed, or a filename that fails the
  // route's charset check). Without this filter the page mounts a viewer that can
  // only ever fail, so the sheets' attachments are carried here too — not just
  // their active state.
  //
  // WHY the service-role client (the same `admin` const created above): the route
  // performs its is_active check on the service-role client, and mirroring that
  // check needs the same unfiltered view of study_sheets. A user-scoped read would
  // be narrowed by RLS — staff-audience sheets are invisible to students — which
  // would wrongly hide annotated PDFs the student is entitled to review (this
  // route is the deliberate exception that lets a student see a staff-audience PDF
  // their own teacher marked up in their own class).
  //
  // This query is DISPLAY-FILTERING ONLY, never an access gate: authorisation
  // remains with the RLS-bound lesson_annotations read above and the route's own
  // user-scoped RLS gate.
  const activeSheetAttachments = new Map<string, SheetAttachment[]>();
  if (markedRows.length > 0) {
    const sheetIds = Array.from(
      new Set(markedRows.map((r) => r.study_sheet_id as string))
    );
    const { data: sheetRows, error: sheetsError } = await admin
      .from('study_sheets')
      .select('id, is_active, attachments')
      .in('id', sheetIds);

    if (sheetsError) {
      // Fail soft for the page, closed for the display: nothing is verified
      // servable, so the annotated-PDF section renders empty rather than mounting
      // viewers whose every file request would 404.
      console.error(
        '[student/past-classes/[id]] study sheet active-state fetch failed:',
        sheetsError
      );
    } else {
      for (const s of sheetRows ?? []) {
        // Inactive sheets are never entered, so absence from this map means
        // "deactivated, or never fetched" — both non-servable.
        if (s.is_active === true) {
          activeSheetAttachments.set(
            s.id as string,
            (Array.isArray(s.attachments) ? s.attachments : []) as SheetAttachment[]
          );
        }
      }
    }
  }

  // Flatten joins
  const flatLesson = {
    ...lesson,
    teacher: Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson.teacher,
    report,
  };

  const flatAssignments = (assignments ?? []).map((a) => ({
    ...a,
    study_sheet: Array.isArray(a.study_sheet) ? a.study_sheet[0] : a.study_sheet,
  }));

  // Each annotation row corresponds to a PDF the teacher marked up during the
  // class (marks are only ever created through the PDF viewer). Shape for the
  // client, which renders one read-only viewer per entry — rows whose sheet was
  // deactivated and rows whose attachment no longer resolves on that sheet are
  // both dropped, since their bytes are no longer servable.
  const annotatedPdfs = markedRows
    .filter((r) => {
      const attachments = activeSheetAttachments.get(r.study_sheet_id as string);
      if (!attachments) return false;
      return attachmentResolves(
        attachments,
        r.attachment_name,
        r.attachment_index as number
      );
    })
    .map((r) => ({
      studySheetId: r.study_sheet_id as string,
      attachmentIndex: r.attachment_index as number,
      annotations: (Array.isArray(r.annotations) ? r.annotations : []) as Annotation[],
    }));

  return (
    <PastClassDetailClient
      lesson={flatLesson}
      assignments={flatAssignments}
      annotatedPdfs={annotatedPdfs}
      existingReview={existingReview ?? null}
      studentId={student.id}
      studentTimezone={requireTz(student.timezone, 'past-class-detail:student')}
    />
  );
}
