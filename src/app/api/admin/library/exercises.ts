// Shared translation for admin Study Sheet exercises.
//
// The admin Study Sheet modal authors exercises in a UI shape and sends them in
// the request body under content.exercises. Exercises actually live in the
// public.exercises TABLE — the source the student and teacher readers query —
// never in study_sheets.content. Both the create (POST) and edit (PATCH) routes
// run every authored exercise through this one function so their translation can
// never drift apart.
//
// Incoming (modal) item: { question, options: string[], correct_index, explanation }
// Outgoing (table) row:   { study_sheet_id, question_text, options, correct_answer,
//                           explanation, duration_minutes }

export type ExerciseRow = {
  study_sheet_id: string
  question_text: string
  options: string[]
  correct_answer: string
  explanation: string
  duration_minutes: number
}

// Duration isn't authored in the admin modal; the teacher form writes a value, so
// we mirror that with a fixed default rather than leaving the column null.
const DEFAULT_DURATION_MINUTES = 5

export function buildExerciseRows(sheetId: string, rawExercises: unknown): ExerciseRow[] {
  if (!Array.isArray(rawExercises)) return []

  const rows: ExerciseRow[] = []

  for (const item of rawExercises) {
    if (!item || typeof item !== 'object') continue
    const ex = item as Record<string, unknown>

    // Skip blank questions, exactly as the teacher form does.
    const question = typeof ex.question === 'string' ? ex.question.trim() : ''
    if (!question) continue

    // Stored options: trimmed, non-empty. correct_answer is NOT NULL and must be
    // one of these, so an exercise with no usable option can't be represented — skip.
    const rawOptions = Array.isArray(ex.options) ? ex.options : []
    const options = rawOptions
      .map(o => (typeof o === 'string' ? o.trim() : ''))
      .filter(o => o.length > 0)
    if (options.length === 0) continue

    // correct_index points into the modal's ORIGINAL (unfiltered) options array,
    // so resolve the chosen text there — indexing the filtered array would shift
    // whenever a blank precedes the correct option. Then guarantee the result is a
    // member of the stored options, falling back to the first option otherwise.
    // This can never yield a null/undefined correct_answer.
    const idx = typeof ex.correct_index === 'number' ? ex.correct_index : 0
    const chosen =
      idx >= 0 && idx < rawOptions.length && typeof rawOptions[idx] === 'string'
        ? (rawOptions[idx] as string).trim()
        : ''
    const correct_answer = options.includes(chosen) ? chosen : options[0]

    rows.push({
      study_sheet_id: sheetId,
      question_text: question,
      options,
      correct_answer,
      explanation: typeof ex.explanation === 'string' ? ex.explanation : '',
      duration_minutes: DEFAULT_DURATION_MINUTES,
    })
  }

  return rows
}
