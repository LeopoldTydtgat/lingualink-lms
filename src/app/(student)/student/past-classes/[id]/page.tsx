import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import PastClassDetailClient from './PastClassDetailClient';
import { requireTz } from '@/lib/time/requireTz';
import type { Annotation } from '@/components/pdf/PdfViewer';

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

  // Fetch the lesson — confirm it belongs to this student
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
      ),
      reports (
        id,
        feedback_text,
        did_class_happen,
        level_data,
        additional_details
      )
    `)
    .eq('id', id)
    .eq('student_id', student.id)
    .maybeSingle();

  if (!lesson) notFound();

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
  const { data: annotatedRows } = await supabase
    .from('lesson_annotations')
    .select('study_sheet_id, attachment_index, annotations')
    .eq('lesson_id', id)
    .order('study_sheet_id', { ascending: true })
    .order('attachment_index', { ascending: true });

  // Flatten joins
  const flatLesson = {
    ...lesson,
    teacher: Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson.teacher,
    report: Array.isArray(lesson.reports) ? lesson.reports[0] : lesson.reports ?? null,
  };

  const flatAssignments = (assignments ?? []).map((a) => ({
    ...a,
    study_sheet: Array.isArray(a.study_sheet) ? a.study_sheet[0] : a.study_sheet,
  }));

  // Each annotation row corresponds to a PDF the teacher marked up during the
  // class (marks are only ever created through the PDF viewer). Shape for the
  // client, which renders one read-only viewer per entry.
  const annotatedPdfs = (annotatedRows ?? [])
    .filter((r) => Array.isArray(r.annotations) && r.annotations.length > 0)
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