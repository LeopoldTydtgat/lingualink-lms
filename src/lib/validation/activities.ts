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

// ─── Grade submission ─────────────────────────────────────────────────────────
// Request body for POST /api/student/activities/[id]/grade.

export const GradeSubmissionSchema = z.object({
  answers: z.record(z.string(), z.string()),
  assignment_id: z.string().uuid('Must be a valid ID').optional(),
})

export type McqQuestion = z.infer<typeof McqQuestionSchema>
export type McqContent = z.infer<typeof McqContentSchema>
export type McqAnswerKeyEntry = z.infer<typeof McqAnswerKeyEntrySchema>
export type McqAnswerKey = z.infer<typeof McqAnswerKeySchema>
export type GradeSubmissionInput = z.infer<typeof GradeSubmissionSchema>
