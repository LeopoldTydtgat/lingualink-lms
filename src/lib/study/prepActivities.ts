import { McqContentSchema, McqAnswerKeySchema, type McqAnswerKeyEntry } from '@/lib/validation/activities'

// Server-side resolution of an activity into plain, client-safe data for the
// teacher study-sheet detail view.
//
// The raw answer_key jsonb never crosses this boundary: it is parsed here and
// only its resolved strings (correctAnswer / explanation) are carried forward.
// Callers that must NOT reveal answers (e.g. the screen-shareable live window)
// pass `rawAnswerKey = null`, which yields the same question list with null
// correctAnswer/explanation.
//
// Non-MCQ or malformed content -> gradable:false and an empty question list
// (the "not an auto-graded activity" marker). This never throws.

export type PreppedQuestion = {
  id: string
  text: string
  options: string[]
  correctAnswer: string | null
  explanation: string | null
}

export type PreppedActivity = {
  id: string
  title: string | null
  type: string
  gradable: boolean
  questions: PreppedQuestion[]
}

type BasicActivity = {
  id: string
  type: string
  title: string | null
  content: unknown
}

export function prepActivity(activity: BasicActivity, rawAnswerKey: unknown): PreppedActivity {
  const base = { id: activity.id, title: activity.title, type: activity.type }

  // MCQ is the only auto-gradable type in this build; everything else has no
  // shape we can resolve into questions here.
  if (activity.type !== 'mcq') return { ...base, gradable: false, questions: [] }

  const parsedContent = McqContentSchema.safeParse(activity.content)
  if (!parsedContent.success) return { ...base, gradable: false, questions: [] }

  const parsedKey = rawAnswerKey != null ? McqAnswerKeySchema.safeParse(rawAnswerKey) : null
  const keyed: Record<string, McqAnswerKeyEntry> =
    parsedKey && parsedKey.success ? parsedKey.data.questions : {}

  const questions: PreppedQuestion[] = parsedContent.data.questions.map(q => {
    // Own-property lookups only — a question id such as 'toString' must not
    // resolve off Object.prototype (mirrors the grade route).
    const entry = Object.hasOwn(keyed, q.id) ? keyed[q.id] : undefined
    return {
      id: q.id,
      text: q.question_text,
      options: q.options,
      correctAnswer: entry?.correct_answer ?? null,
      explanation: entry?.explanation ?? null,
    }
  })

  return { ...base, gradable: true, questions }
}
