import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect } from 'next/navigation';
import PastClassesClient from './PastClassesClient';
import { requireTz } from '@/lib/time/requireTz';
import { STUDENT_PAST_LESSON_STATUSES } from '@/lib/billing/billability';

// Shape handed to PastClassesClient as `lesson.report`. Kept in sync with the
// client's own Report interface - the select list below must cover exactly these
// fields and nothing else.
type StudentVisibleReport = {
  id: string;
  feedback_text: string | null;
  did_class_happen: boolean | null;
  level_data: Record<string, string> | null;
};

export default async function PastClassesPage() {
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

  // One "now" for the whole request so the SQL prefilter and the JS end-time
  // filter below can never straddle a tick. Both are UTC INSTANT comparisons
  // against a timestamptz column, not local calendar-date construction - which
  // is what the repo's toISOString ban covers.
  // `new Date()` rather than Date.now(): the react-hooks/purity rule (React
  // Compiler, via eslint-config-next) mis-fires on Date.now() in async Server
  // Components. Same single instant, no file-wide rule disable needed.
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // Fetch this student's past lessons - report-independent by design (client
  // approved): a class the teacher has not reported on yet is still 'scheduled'
  // in the DB, so the settled-status set alone would hide an ended class until
  // the report landed. 'scheduled' is admitted here and narrowed to ENDED rows
  // by the JS filter below. STUDENT_PAST_LESSON_STATUSES itself stays
  // settled-only: 'missed' and every cancellation remain excluded.
  // The .lte() only trims FUTURE 'scheduled' rows - a report can only be filed
  // once the class has started, so every settled row already has scheduled_at
  // in the past and none are lost by it.
  // This RLS-bound query is the ownership gate: every lesson id it returns is
  // proven to belong to this student. Reports are NOT embedded here - see below.
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
      )
    `)
    .eq('student_id', student.id)
    .in('status', [...STUDENT_PAST_LESSON_STATUSES, 'scheduled'])
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: false });

  // Settled rows pass straight through. A 'scheduled' row counts as past only
  // once its END instant (start + duration) has passed, so a class that is
  // currently IN PROGRESS never appears in the history list.
  const lessonRows = (lessons ?? []).filter((lesson) => {
    if (lesson.status !== 'scheduled') return true;
    const endMs =
      new Date(lesson.scheduled_at as string).getTime() +
      (lesson.duration_minutes as number) * 60000;
    return endMs <= nowMs;
  });

  // public.reports has RLS policies for teachers and admins only - there is no
  // student SELECT policy, and that is deliberate: a student policy would expose
  // the whole row including student_confirmed and impersonation_note (a fraud flag
  // the teacher writes ABOUT the student), and column-level REVOKE cannot separate
  // students from teachers because both share the `authenticated` role.
  // So read the safe columns server-side through the service-role client, exactly
  // as (dashboard)/account/page.tsx reads student_reviews. The .in() filter is
  // restricted to lesson ids the RLS-bound query above already proved belong to
  // this student - that filter IS the security boundary, because the admin client
  // bypasses RLS. Never widen this select list.
  // An ended-but-unreported 'scheduled' lesson simply has no row here, so it maps
  // to report: null and the client renders its awaiting-feedback state.
  const reportsByLessonId = new Map<string, StudentVisibleReport>();

  if (lessonRows.length > 0) {
    const admin = createAdminClient();
    const { data: reportRows, error: reportsError } = await admin
      .from('reports')
      .select('id, lesson_id, feedback_text, did_class_happen, level_data')
      .in('lesson_id', lessonRows.map((lesson) => lesson.id));

    if (reportsError) {
      // Fail soft: the page still renders, every card just falls back to the
      // no-feedback placeholder rather than 500-ing the whole history view.
      console.error('[student/past-classes] reports fetch failed:', reportsError);
    } else {
      // reports has a UNIQUE constraint on lesson_id, so at most one row per
      // lesson - a plain Map is unambiguous, no array flattening needed.
      for (const row of reportRows ?? []) {
        reportsByLessonId.set(row.lesson_id as string, {
          id: row.id as string,
          feedback_text: (row.feedback_text ?? null) as string | null,
          did_class_happen: (row.did_class_happen ?? null) as boolean | null,
          level_data: (row.level_data ?? null) as Record<string, string> | null,
        });
      }
    }
  }

  // Fetch all reviews this student has already submitted
  const { data: reviews } = await supabase
    .from('student_reviews')
    .select('id, class_id, rating, review_text')
    .eq('student_id', student.id);

  // Flatten nested Supabase join results
  const flattenedLessons = lessonRows.map((lesson) => ({
    ...lesson,
    teacher: Array.isArray(lesson.teacher) ? lesson.teacher[0] : lesson.teacher,
    report: reportsByLessonId.get(lesson.id as string) ?? null,
  }));

  const reviewedClassIds = new Set((reviews ?? []).map((r) => r.class_id));

  return (
    <PastClassesClient
      lessons={flattenedLessons}
      studentTimezone={requireTz(student.timezone, 'past-classes:student')}
      reviewedClassIds={[...reviewedClassIds]}
      studentId={student.id}
    />
  );
}
