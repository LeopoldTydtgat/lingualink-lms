import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  GradeSubmissionSchema,
  McqAnswerKeySchema,
  McqContentSchema,
  type McqAnswerKeyEntry,
  type McqQuestion,
} from '@/lib/validation/activities'

interface QuestionResult {
  correct: boolean
  correct_answer: string
  explanation: string | null
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // A non-uuid path segment can never name a row, and would otherwise reach
    // Postgres as a 22P02 cast error and surface as a 500.
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    const supabase = await createClient()

    // ── 1. Authenticated user ────────────────────────────────────────────────
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // ── 2. Resolve the student ───────────────────────────────────────────────
    // auth_user_id is the only indirection from auth.users to students — the
    // auth uid is never a students PK.
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    if (!student) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── 3. Validate the submission ───────────────────────────────────────────
    // A malformed/absent JSON body fails safeParse → 400, never a 500.
    const body = await req.json().catch(() => null)
    const parsedBody = GradeSubmissionSchema.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsedBody.error.flatten() },
        { status: 400 }
      )
    }
    const { answers, assignment_id: assignmentId } = parsedBody.data

    // ── 4. Fetch the activity through the USER-SCOPED client ─────────────────
    // RLS restricts activities to sheets this user can see, and the
    // `authenticated` column grant excludes answer_key, so this read cannot
    // surface it. Never the admin client here — that would bypass the
    // visibility check that authorises the whole request.
    const { data: activity, error: activityError } = await supabase
      .from('activities')
      .select('id, sheet_id, type, content')
      .eq('id', id)
      .maybeSingle()

    // maybeSingle() reports the invisible-row case as {data: null, error: null},
    // so a non-null error is a genuine fault — never a "not found".
    if (activityError) {
      console.error('activities read error:', id, activityError)
      return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
    }
    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    // ── 5. The sheet must be student-facing ──────────────────────────────────
    // The activities RLS policy only asserts the sheet is visible, and
    // study_sheets SELECT policies are permissive (OR'd): a dual-identity user
    // holding both a profiles row and a students row sees the union of the
    // student and teacher tiers. Without this check such a user could grade a
    // staff-audience activity and be handed its answer key below. Mirrors the
    // explicit audience scoping in student/study/[id]/page.tsx.
    const { data: sheet, error: sheetError } = await supabase
      .from('study_sheets')
      .select('id')
      .eq('id', activity.sheet_id)
      .eq('is_active', true)
      .eq('audience', 'student')
      .maybeSingle()

    if (sheetError) {
      console.error('study_sheets read error:', activity.sheet_id, sheetError)
      return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
    }
    if (!sheet) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    // ── 6. MCQ is the only auto-gradable type in this build ──────────────────
    if (activity.type !== 'mcq') {
      return NextResponse.json(
        { error: 'This activity type cannot be auto-graded.' },
        { status: 422 }
      )
    }

    // ── 7. Authored content must be well-formed ──────────────────────────────
    // Malformed content is an authoring problem, not the student's — 500.
    const parsedContent = McqContentSchema.safeParse(activity.content)
    if (!parsedContent.success) {
      console.error('Malformed MCQ content:', id, parsedContent.error.issues)
      return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
    }
    const questions = parsedContent.data.questions

    // ── 8. Answer key — service role only ────────────────────────────────────
    const admin = createAdminClient()
    const { data: keyRow, error: keyError } = await admin
      .from('activities')
      .select('answer_key')
      .eq('id', id)
      .maybeSingle()

    if (keyError || !keyRow?.answer_key) {
      console.error('activity answer_key read error:', id, keyError)
      return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
    }

    const parsedKey = McqAnswerKeySchema.safeParse(keyRow.answer_key)
    if (!parsedKey.success) {
      console.error('Malformed MCQ answer key:', id, parsedKey.error.issues)
      return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
    }
    const answerKey = parsedKey.data.questions

    // ── 9. The submission must answer exactly this activity's questions ──────
    const questionIds = new Set(questions.map(q => q.id))
    const unknownIds = Object.keys(answers).filter(qid => !questionIds.has(qid))
    if (unknownIds.length > 0) {
      return NextResponse.json({ error: 'Invalid answers submitted.' }, { status: 400 })
    }

    const submissions: Array<{
      question: McqQuestion
      answer: string
      key: McqAnswerKeyEntry
    }> = []

    for (const question of questions) {
      // Own-property lookups only: a question id such as 'toString' would
      // otherwise resolve off Object.prototype and slip past these guards.
      const key = Object.hasOwn(answerKey, question.id)
        ? answerKey[question.id]
        : undefined

      // A question with no answer-key entry is malformed authoring, not a bad
      // submission — same 500 as malformed content.
      if (!key) {
        console.error('MCQ answer key missing question:', id, question.id)
        return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
      }

      const answer = Object.hasOwn(answers, question.id)
        ? answers[question.id]
        : undefined

      if (typeof answer !== 'string' || answer.trim() === '') {
        return NextResponse.json(
          { error: 'All questions must be answered.' },
          { status: 400 }
        )
      }

      // An answer outside the authored options can never be correct and would
      // only persist junk in activity_attempts.answers. Compared trimmed, to
      // match grading — whitespace alone never rejects a real selection.
      if (!question.options.some(opt => opt.trim() === answer.trim())) {
        return NextResponse.json({ error: 'Invalid answers submitted.' }, { status: 400 })
      }

      submissions.push({ question, answer, key })
    }

    // ── 10. A client-supplied assignment_id must belong to this student ──────
    if (assignmentId) {
      // The assignment must target this activity's sheet — otherwise a student
      // could stamp any of their assignments onto any attempt.
      const { data: assignment, error: assignmentError } = await admin
        .from('assignments')
        .select('id')
        .eq('id', assignmentId)
        .eq('student_id', student.id)
        .eq('study_sheet_id', activity.sheet_id)
        .maybeSingle()

      if (assignmentError) {
        console.error('assignment ownership check error:', assignmentId, assignmentError)
        return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
      }
      if (!assignment) {
        return NextResponse.json({ error: 'Invalid assignment.' }, { status: 400 })
      }
    }

    // ── 11. Grade ────────────────────────────────────────────────────────────
    const results: Record<string, QuestionResult> = {}
    let correctCount = 0

    for (const { question, answer, key } of submissions) {
      const correct = answer.trim() === key.correct_answer.trim()
      if (correct) correctCount += 1
      results[question.id] = {
        correct,
        correct_answer: key.correct_answer,
        explanation: key.explanation ?? null,
      }
    }

    // questions is min(1) by schema — no divide-by-zero.
    const score = Math.round((correctCount / questions.length) * 100)

    // ── 12. Persist the attempt ──────────────────────────────────────────────
    // Writes to activity_attempts are service_role only.
    const { error: insertError } = await admin.from('activity_attempts').insert({
      student_id: student.id,
      activity_id: id,
      assignment_id: assignmentId ?? null,
      answers,
      score,
      needs_review: false,
      graded_at: new Date().toISOString(),
    })

    if (insertError) {
      // Never reveal the answers when the attempt did not record — an
      // ungraded-but-revealed state would let a student read the key for free.
      console.error('activity_attempts insert error:', id, insertError)
      return NextResponse.json({ error: 'Failed to save your attempt' }, { status: 500 })
    }

    // ── 13. Grading results ──────────────────────────────────────────────────
    return NextResponse.json({ score, results })
  } catch (err) {
    console.error('activity grade route error:', err)
    return NextResponse.json({ error: 'Failed to grade activity' }, { status: 500 })
  }
}
