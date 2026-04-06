import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import PastClassesClient from './PastClassesClient';

export default async function PastClassesPage() {
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

  // Fetch all completed or no-show lessons for this student
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      teacher:profiles!lessons_teacher_id_fkey (
        id,
        full_name,
        photo_url
      ),
      reports (
        id,
        feedback_text,
        did_class_happen,
        level_data
      )
    `)
    .eq('student_id', student.id)
    .in('status', ['completed', 'student_no_show', 'teacher_no_show'])
    .order('scheduled_at', { ascending: false });

  // Fetch all reviews this student has already submitted
  const { data: reviews } = await supabase
    .from('student_reviews')
    .select('id, class_id, rating, review_text')
    .eq('student_id', student.id);

  // Flatten nested Supabase join results
  const flattenedLessons = (lessons ?? []).map((lesson) => ({
    ...lesson,
    teacher: Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson.teacher,
    report: Array.isArray(lesson.reports) ? lesson.reports[0] : lesson.reports ?? null,
  }));

  const reviewedClassIds = new Set((reviews ?? []).map((r) => r.class_id));

  return (
    <PastClassesClient
      lessons={flattenedLessons}
      studentTimezone={student.timezone ?? 'UTC'}
      reviewedClassIds={[...reviewedClassIds]}
      studentId={student.id}
    />
  );
}