import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { z } from 'zod'
import { McqContentSchema } from '@/lib/validation/activities'
import ActivityPlayerClient from './ActivityPlayerClient'

interface Props {
  params: Promise<{ id: string }>
}

function Unavailable() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <p className="text-sm text-gray-400 text-center py-10">
        This activity is unavailable.
      </p>
    </div>
  )
}

export default async function ActivityPage({ params }: Props) {
  const { id } = await params

  // A non-uuid segment can never name a row; without this it reaches Postgres
  // as a 22P02 cast error rather than a clean not-found.
  if (!z.string().uuid().safeParse(id).success) notFound()

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (!student) redirect('/student/login')

  // User-scoped read: RLS restricts activities to sheets visible to this
  // student, and the `authenticated` column grant excludes answer_key — the
  // key cannot reach this page, let alone the client.
  const { data: activity, error: activityError } = await supabase
    .from('activities')
    .select('id, sheet_id, type, title, content')
    .eq('id', id)
    .maybeSingle()

  // maybeSingle() reports the invisible-row case as {data: null, error: null},
  // so a non-null error is a genuine fault — don't report it as not-found.
  if (activityError) {
    console.error('activities read error:', id, activityError)
    return <Unavailable />
  }
  if (!activity) notFound()

  // The activities RLS policy only asserts the sheet is visible, and
  // study_sheets SELECT policies are permissive (OR'd): a dual-identity user
  // holding both a profiles row and a students row sees the union of the
  // student and teacher tiers. Scope to student-facing sheets explicitly, as
  // student/study/[id]/page.tsx does.
  const { data: sheet, error: sheetError } = await supabase
    .from('study_sheets')
    .select('id')
    .eq('id', activity.sheet_id)
    .eq('is_active', true)
    .eq('audience', 'student')
    .maybeSingle()

  if (sheetError) {
    console.error('study_sheets read error:', activity.sheet_id, sheetError)
    return <Unavailable />
  }
  if (!sheet) notFound()

  // Only MCQ is playable in this build. Anything else would render a player
  // whose submit can only ever 422 — show the fallback instead of a dead end.
  if (activity.type !== 'mcq') return <Unavailable />

  // Malformed authored content must not crash the page.
  const parsedContent = McqContentSchema.safeParse(activity.content)
  if (!parsedContent.success) {
    console.error('Malformed MCQ content:', activity.id, parsedContent.error.issues)
    return <Unavailable />
  }

  // Latest attempt only. RLS scopes activity_attempts to this student's own
  // rows; the student_id filter is defence in depth, not the gate.
  const { data: lastAttempt } = await supabase
    .from('activity_attempts')
    .select('id, score, created_at')
    .eq('activity_id', id)
    .eq('student_id', student.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <ActivityPlayerClient
      activityId={activity.id}
      title={activity.title}
      questions={parsedContent.data.questions}
      previousScore={lastAttempt?.score ?? null}
    />
  )
}
