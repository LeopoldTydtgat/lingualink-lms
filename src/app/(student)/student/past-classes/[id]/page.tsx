import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import PastClassDetailClient from './PastClassDetailClient';

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
    .select('id, full_name, timezone')
    .eq('auth_user_id', user.id)
    .single();

  if (!student) redirect('/student/login');

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
    .single();

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

  return (
    <PastClassDetailClient
      lesson={flatLesson}
      assignments={flatAssignments}
      existingReview={existingReview ?? null}
      studentId={student.id}
      studentTimezone={student.timezone ?? 'UTC'}
    />
  );
}