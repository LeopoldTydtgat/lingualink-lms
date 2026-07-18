import { z } from 'zod'

// Grading compares trimmed values, so a value that is only whitespace is
// effectively empty: `.min(1)` alone would accept '   ', which trims to '' —
// an option no submission can ever match, or a question no student can answer.
const nonBlankString = (message: string) =>
  z.string().refine(s => s.trim().length > 0, message)

// ─── MCQ authored content ─────────────────────────────────────────────────────
// activities.content — safe to ship to the client. Carries no answer data.

export const McqQuestionSchema = z
  .object({
    id: nonBlankString('Question id is required'),
    question_text: nonBlankString('Question text is required'),
    options: z
      .array(nonBlankString('An option cannot be empty'))
      .min(2, 'A question needs at least 2 options')
      .max(6, 'A question can have at most 6 options'),
  })
  .superRefine((val, ctx) => {
    // Options are graded by trimmed exact match. Two options differing only by
    // whitespace would both grade correct, and identical option text would
    // highlight both when either is picked (selection is keyed by value).
    const seen = new Set<string>()
    val.options.forEach((opt, idx) => {
      const key = opt.trim()
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', idx],
          message: `Duplicate option '${key}'`,
        })
      }
      seen.add(key)
    })
  })

export const McqContentSchema = z
  .object({
    questions: z.array(McqQuestionSchema).min(1, 'An activity needs at least 1 question'),
  })
  .superRefine((val, ctx) => {
    // Question ids key both the answer key and the submitted answers — a
    // duplicate would silently collapse two questions into one.
    const seen = new Set<string>()
    val.questions.forEach((q, idx) => {
      if (seen.has(q.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', idx, 'id'],
          message: `Duplicate question id '${q.id}'`,
        })
      }
      seen.add(q.id)
    })
  })

// ─── MCQ answer key ───────────────────────────────────────────────────────────
// activities.answer_key — service_role reads only. The `authenticated` column
// grant on activities excludes this column, so it never reaches a user-scoped
// query. It must never be returned to a client before grading.

export const McqAnswerKeyEntrySchema = z.object({
  correct_answer: nonBlankString('correct_answer is required'),
  explanation: z.string().optional(),
})

export const McqAnswerKeySchema = z.object({
  questions: z.record(z.string(), McqAnswerKeyEntrySchema),
})

// ─── MCQ authoring (admin builder) ────────────────────────────────────────────
// Request body for the admin create/edit routes. Content and answer key are
// authored together and must be validated together: each is individually valid
// yet the pair can still be incoherent, and the grade route treats every
// mismatch it meets at runtime as a 500 (malformed authoring). These cross-checks
// are what stop an admin from saving an activity that can never be graded.

export const McqActivityAuthorSchema = z
  .object({
    title: nonBlankString('Title is required'),
    content: McqContentSchema,
    answer_key: McqAnswerKeySchema,
  })
  .superRefine((val, ctx) => {
    const questions = val.content.questions
    const keyed = val.answer_key.questions
    const questionIds = new Set(questions.map(q => q.id))

    // Extra key entries: a key for a question that does not exist. Harmless to
    // grading, but it is dead answer data sitting in the row and a reliable sign
    // the two halves drifted apart.
    for (const keyId of Object.keys(keyed)) {
      if (!questionIds.has(keyId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answer_key', 'questions', keyId],
          message: `The answer key has an entry for '${keyId}', which is not a question in this activity`,
        })
      }
    }

    questions.forEach((question, idx) => {
      // Own-property lookups only: a question id such as 'toString' would
      // otherwise resolve off Object.prototype and pass these checks with a
      // function as its "entry". Mirrors the grade route.
      const entry = Object.hasOwn(keyed, question.id) ? keyed[question.id] : undefined

      // Missing key entry: the grade route 500s on this at submit time.
      if (!entry) {
        ctx.addIssue({
          code: 'custom',
          path: ['answer_key', 'questions', question.id],
          message: `Question ${idx + 1} has no answer key entry`,
        })
        return
      }

      // The correct answer must be one of the options the student is shown,
      // compared trimmed — exactly how the grade route matches a submission.
      // Otherwise no answer can ever grade correct.
      if (!question.options.some(opt => opt.trim() === entry.correct_answer.trim())) {
        ctx.addIssue({
          code: 'custom',
          path: ['answer_key', 'questions', question.id, 'correct_answer'],
          message: `Question ${idx + 1}: the correct answer must be one of its options`,
        })
      }
    })
  })

// ─── Writing task authored content ────────────────────────────────────────────
// activities.content for a writing_task. A single free-text prompt shown to the
// student. There is no answer key: a writing task is not auto-graded, so
// activities.answer_key stays null and is never written for this type.

export const WritingTaskContentSchema = z.object({
  prompt: nonBlankString('Prompt is required'),
})

// ─── Writing task authoring (admin builder) ───────────────────────────────────
// Request body for the admin create/edit routes. Unlike MCQ there is no
// answer_key half — a writing task carries no answers to store or cross-check.
// This schema shares no shape with McqActivityAuthorSchema: its content requires
// `prompt` and forbids nothing else, while the MCQ schema requires
// `content.questions` and `answer_key`. A body valid for one is invalid for the
// other, which is what lets the routes discriminate types safely.

export const WritingTaskActivityAuthorSchema = z.object({
  title: nonBlankString('Title is required'),
  content: WritingTaskContentSchema,
})

// ─── Grade submission ─────────────────────────────────────────────────────────
// Request body for POST /api/student/activities/[id]/grade.

export const GradeSubmissionSchema = z.object({
  answers: z.record(z.string(), z.string()),
  assignment_id: z.string().uuid('Must be a valid ID').optional(),
})

// ─── Writing task submission ──────────────────────────────────────────────────
// Request body for POST /api/student/activities/[id]/submit-writing. A writing
// task is not auto-graded — the student sends free text that a teacher later
// reviews. `.max` caps the raw input; the `.refine` rejects whitespace-only
// text (which trims to nothing), mirroring nonBlankString.

export const WritingTaskSubmissionSchema = z.object({
  response_text: z
    .string()
    .max(10000, 'Your response is too long (10000 characters max).')
    .refine(s => s.trim().length > 0, 'A response is required.'),
  assignment_id: z.string().uuid('Must be a valid ID').optional(),
})

export type McqQuestion = z.infer<typeof McqQuestionSchema>
export type McqContent = z.infer<typeof McqContentSchema>
export type McqAnswerKeyEntry = z.infer<typeof McqAnswerKeyEntrySchema>
export type McqAnswerKey = z.infer<typeof McqAnswerKeySchema>
export type McqActivityAuthorInput = z.infer<typeof McqActivityAuthorSchema>
export type WritingTaskContent = z.infer<typeof WritingTaskContentSchema>
export type WritingTaskActivityAuthorInput = z.infer<typeof WritingTaskActivityAuthorSchema>
export type GradeSubmissionInput = z.infer<typeof GradeSubmissionSchema>
export type WritingTaskSubmissionInput = z.infer<typeof WritingTaskSubmissionSchema>
