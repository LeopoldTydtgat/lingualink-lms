'use client'

import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type ActivityType = 'mcq' | 'writing_task'

type Props = {
  sheetId: string
  activityId: string | null   // null = create mode
  createType?: ActivityType   // create mode only; ignored on edit (type comes from the row)
  onClose: () => void
  onSaved: () => Promise<void>
}

// The editing shape. correct_index is the editor's way of holding the answer;
// it is translated to/from answer_key.questions[id].correct_answer (the stored
// shape) on load and save.
type QuestionDraft = {
  id: string
  question_text: string
  options: string[]
  correct_index: number
  explanation: string
}

type LoadedActivity = {
  type: string
  title: string | null
  content: unknown
  answer_key: unknown
}

// `unresolved` means at least one question's stored answer could not be located
// among its options. The editor cannot represent that, and guessing would rewrite
// a real answer key on the next save — so it blocks editing instead.
type DraftLoad = {
  drafts: QuestionDraft[]
  unresolved: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Mirrors McqQuestionSchema's options min(2)/max(6).
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

const ORANGE = '#FF8303'
const GREEN = '#16a34a'

const LOAD_FAILED_MESSAGE =
  "Couldn't load this activity. Close and reopen it — saving now would overwrite its questions."

const UNRESOLVED_KEY_MESSAGE =
  "This activity's answer key doesn't match its options, so it can't be edited here — saving would overwrite the real answers. Recreate the activity, or fix its answer key directly."

// ── Helpers ───────────────────────────────────────────────────────────────────

function newQuestion(): QuestionDraft {
  return {
    id: crypto.randomUUID(),
    question_text: '',
    options: ['', ''],
    correct_index: 0,
    explanation: '',
  }
}

function optionLabel(index: number): string {
  return String.fromCharCode(65 + index)
}

// Inverse of the save translation below: rebuild the editor shape from a stored
// activity. correct_index is recovered by locating correct_answer among the
// options, compared trimmed — exactly how the grade route matches it.
function toDrafts(content: unknown, answerKey: unknown): DraftLoad {
  const questions =
    content && typeof content === 'object' && Array.isArray((content as { questions?: unknown }).questions)
      ? ((content as { questions: unknown[] }).questions)
      : []

  const keyed =
    answerKey && typeof answerKey === 'object' && (answerKey as { questions?: unknown }).questions &&
    typeof (answerKey as { questions: unknown }).questions === 'object'
      ? ((answerKey as { questions: Record<string, unknown> }).questions)
      : {}

  let unresolved = false

  const drafts = questions.map(raw => {
    const q = (raw ?? {}) as { id?: unknown; question_text?: unknown; options?: unknown }
    const id = typeof q.id === 'string' && q.id.length > 0 ? q.id : crypto.randomUUID()
    const options = Array.isArray(q.options) ? q.options.map(o => String(o ?? '')) : []

    // Own-property lookup only: an id like 'toString' would otherwise resolve off
    // Object.prototype. Mirrors the grade route.
    const entryRaw = Object.hasOwn(keyed, id) ? keyed[id] : undefined
    const entry = (entryRaw ?? {}) as { correct_answer?: unknown; explanation?: unknown }

    // A blank correct_answer is treated as absent: options are non-blank by
    // schema, so '' could only ever match a malformed option and would resolve a
    // real question to the wrong answer.
    const correctAnswer = typeof entry.correct_answer === 'string' ? entry.correct_answer : ''
    const hasAnswer = entryRaw != null && correctAnswer.trim().length > 0

    const foundIndex = hasAnswer
      ? options.findIndex(opt => opt.trim() === correctAnswer.trim())
      : -1

    // answer_key is nullable in the DB, and rows can be seeded outside this
    // builder. Either way, we could not reconstruct the answer — say so rather
    // than defaulting to option A and writing that back as the truth.
    if (foundIndex < 0) unresolved = true

    return {
      id,
      question_text: typeof q.question_text === 'string' ? q.question_text : '',
      // Pad to the schema minimum so a malformed row is still legible.
      options: options.length >= MIN_OPTIONS ? options : [...options, '', ''].slice(0, MIN_OPTIONS),
      correct_index: foundIndex >= 0 ? foundIndex : 0,
      explanation: typeof entry.explanation === 'string' ? entry.explanation : '',
    }
  })

  return { drafts, unresolved }
}

// Recover the writing-task prompt from stored content. Unlike MCQ there is no
// answer key to reconcile, so a malformed/blank prompt is simply loaded empty:
// there is nothing here that a re-save could destroy, so editing is never blocked.
function toPrompt(content: unknown): string {
  return content && typeof content === 'object' && typeof (content as { prompt?: unknown }).prompt === 'string'
    ? (content as { prompt: string }).prompt
    : ''
}

// Client-side mirror of McqActivityAuthorSchema. The server is the authority —
// this only spares the admin a round trip on the obvious mistakes.
function validate(title: string, questions: QuestionDraft[]): string | null {
  if (!title.trim()) return 'Title is required.'
  if (questions.length === 0) return 'An activity needs at least 1 question.'

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const label = `Question ${i + 1}`

    if (!q.question_text.trim()) return `${label}: question text is required.`
    if (q.options.length < MIN_OPTIONS) return `${label}: needs at least ${MIN_OPTIONS} options.`
    if (q.options.length > MAX_OPTIONS) return `${label}: can have at most ${MAX_OPTIONS} options.`
    if (q.options.some(opt => !opt.trim())) return `${label}: every option needs text.`

    const seen = new Set<string>()
    for (const opt of q.options) {
      const key = opt.trim()
      if (seen.has(key)) return `${label}: duplicate option '${key}'.`
      seen.add(key)
    }

    // Guards the save translation below, which indexes options by correct_index.
    if (q.correct_index < 0 || q.correct_index >= q.options.length) {
      return `${label}: mark which option is correct.`
    }
  }

  return null
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ActivityFormModal({ sheetId, activityId, createType, onClose, onSaved }: Props) {
  const isEdit = activityId !== null

  // Create mode fixes the type up front (chosen in the add-activity flow). Edit
  // mode's initial value is a placeholder: the load effect overwrites it from the
  // stored row before anything but the "Loading…" state is shown.
  const [type, setType] = useState<ActivityType>(isEdit ? 'mcq' : (createType ?? 'mcq'))

  const [title, setTitle] = useState('')
  const [questions, setQuestions] = useState<QuestionDraft[]>(() => isEdit ? [] : [newQuestion()])
  const [prompt, setPrompt] = useState('')

  const [loading, setLoading] = useState(isEdit)
  // Holds the reason the edit-mode load could not produce a safe editing state.
  // Non-null blocks saving: a PATCH replaces content AND answer_key wholesale, so
  // saving a state we could not reconstruct would overwrite the real activity.
  const [loadError, setLoadError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Edit mode: load the activity, including its answer key, through the admin
  // route. The browser client cannot read answer_key at all — the `authenticated`
  // column grant on activities excludes it. Mount-only: the modal remounts per
  // edit, so this never clobbers in-progress edits.
  useEffect(() => {
    if (!isEdit) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/admin/library/${sheetId}/activities/${activityId}`)
        if (cancelled) return

        if (!res.ok) {
          setLoadError(LOAD_FAILED_MESSAGE)
          return
        }

        const data: LoadedActivity | null = await res.json().catch(() => null)
        if (cancelled) return

        if (!data) {
          setLoadError(LOAD_FAILED_MESSAGE)
          return
        }

        const loadedType: ActivityType = data.type === 'writing_task' ? 'writing_task' : 'mcq'
        setType(loadedType)

        if (loadedType === 'writing_task') {
          setTitle(data.title ?? '')
          setPrompt(toPrompt(data.content))
        } else {
          const { drafts, unresolved } = toDrafts(data.content, data.answer_key)

          // A stored MCQ always has at least one question (schema min(1)), so an
          // empty set means the content is malformed — the same hazard as an
          // unreadable answer key, and the same answer: refuse to edit it.
          if (unresolved || drafts.length === 0) {
            setLoadError(UNRESOLVED_KEY_MESSAGE)
            return
          }

          setTitle(data.title ?? '')
          setQuestions(drafts)
        }
      } catch {
        // A rejected fetch must still resolve the loading state, or the modal
        // hangs with Save disabled and no reason shown.
        if (!cancelled) setLoadError(LOAD_FAILED_MESSAGE)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [])

  // ── Question helpers ──────────────────────────────────────────────────────
  const updateQuestion = (id: string, field: 'question_text' | 'explanation', value: string) => {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, [field]: value } : q))
  }

  const updateOption = (id: string, index: number, value: string) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== id) return q
      const options = [...q.options]
      options[index] = value
      return { ...q, options }
    }))
  }

  const setCorrect = (id: string, index: number) => {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, correct_index: index } : q))
  }

  const addOption = (id: string) => {
    setQuestions(prev => prev.map(q =>
      q.id === id && q.options.length < MAX_OPTIONS
        ? { ...q, options: [...q.options, ''] }
        : q
    ))
  }

  const removeOption = (id: string, index: number) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== id || q.options.length <= MIN_OPTIONS) return q
      const options = q.options.filter((_, i) => i !== index)
      // The correct answer is held by index, so dropping a row shifts it. Without
      // this the mark silently jumps to a different option — or points past the
      // end of the array.
      let correct = q.correct_index
      if (index === q.correct_index) correct = 0
      else if (index < q.correct_index) correct = q.correct_index - 1
      return { ...q, options, correct_index: correct }
    }))
  }

  const addQuestion = () => setQuestions(prev => [...prev, newQuestion()])

  const removeQuestion = (id: string) => setQuestions(prev => prev.filter(q => q.id !== id))

  const moveQuestion = (index: number, direction: 'up' | 'down') => {
    setQuestions(prev => {
      const next = [...prev]
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (loading || loadError) return

    let payload: unknown

    if (type === 'writing_task') {
      // Mirror of WritingTaskActivityAuthorSchema; the server remains authority.
      if (!title.trim()) {
        setError('Title is required.')
        return
      }
      if (!prompt.trim()) {
        setError('A prompt is required.')
        return
      }
      // `type` tells the create route which schema to apply. The edit route
      // ignores it (it trusts the stored type), so sending it is harmless there.
      payload = {
        type: 'writing_task',
        title: title.trim(),
        content: { prompt: prompt.trim() },
      }
    } else {
      const validationError = validate(title, questions)
      if (validationError) {
        setError(validationError)
        return
      }

      // Options are stored trimmed and correct_answer is taken from the same
      // trimmed array, so the stored key always matches an option exactly — the
      // cross-check the server runs, and the comparison the grade route makes.
      const content = {
        questions: questions.map(q => ({
          id: q.id,
          question_text: q.question_text.trim(),
          options: q.options.map(opt => opt.trim()),
        })),
      }

      const answer_key = {
        questions: Object.fromEntries(
          questions.map(q => {
            const explanation = q.explanation.trim()
            return [
              q.id,
              {
                correct_answer: q.options[q.correct_index].trim(),
                // Omitted rather than sent empty: explanation is optional, and ''
                // would render as an empty "why" block after grading.
                ...(explanation ? { explanation } : {}),
              },
            ]
          })
        ),
      }

      payload = { title: title.trim(), content, answer_key }
    }

    setSaving(true)
    setError(null)

    let res: Response
    try {
      res = await fetch(
        isEdit
          ? `/api/admin/library/${sheetId}/activities/${activityId}`
          : `/api/admin/library/${sheetId}/activities`,
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
    } catch {
      // Without this the modal would sit at "Saving…" forever and the authored
      // questions could only be recovered by retyping them.
      setError('Could not reach the server, so nothing was saved. Check your connection and try again.')
      setSaving(false)
      return
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Something went wrong. Please try again.')
      setSaving(false)
      return
    }

    setSaving(false)
    await onSaved()
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      // Sits above the activities list modal (z-50) that opens it.
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 60 }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">
            {isEdit ? 'Edit Activity' : 'New Activity'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 thin-scroll">
          {loading ? (
            <p className="text-sm text-gray-400">Loading activity…</p>
          ) : loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : type === 'writing_task' ? (
            <div className="space-y-6">

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Describe Your Morning Routine"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Writing task. The student sees the prompt and submits a written response; it is not auto-graded.
                </p>
              </div>

              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Prompt *</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="e.g. Describe your typical morning routine in 5–6 sentences, using the present simple."
                  rows={6}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-6">

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Present Perfect — Quick Check"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Multiple choice. Students see one question at a time and are graded on submit.
                </p>
              </div>

              {/* Questions */}
              {questions.map((q, i) => (
                <div key={q.id} className="border border-gray-200 rounded-lg p-4 space-y-3">

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-400 uppercase">Question {i + 1}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, 'up')}
                        disabled={i === 0}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm"
                        title="Move up"
                      >↑</button>
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, 'down')}
                        disabled={i === questions.length - 1}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm"
                        title="Move down"
                      >↓</button>
                      <button
                        type="button"
                        onClick={() => removeQuestion(q.id)}
                        disabled={questions.length === 1}
                        className="text-red-400 hover:text-red-600 disabled:opacity-20 text-sm"
                        title={questions.length === 1 ? 'An activity needs at least one question' : 'Remove question'}
                      >✕ Remove</button>
                    </div>
                  </div>

                  {/* Question text */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Question *</label>
                    <input
                      type="text"
                      value={q.question_text}
                      onChange={e => updateQuestion(q.id, 'question_text', e.target.value)}
                      placeholder="e.g. Which sentence is correct?"
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900"
                    />
                  </div>

                  {/* Options */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Options — select the correct one ({MIN_OPTIONS}–{MAX_OPTIONS})
                    </label>
                    <div className="space-y-2">
                      {q.options.map((opt, optIdx) => {
                        const isCorrect = q.correct_index === optIdx
                        return (
                          <div key={optIdx} className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`correct-${q.id}`}
                              checked={isCorrect}
                              onChange={() => setCorrect(q.id, optIdx)}
                              className="flex-shrink-0"
                              style={{ accentColor: GREEN, width: '16px', height: '16px' }}
                              title="Mark as the correct answer"
                            />
                            <span
                              className="text-xs font-bold w-4 flex-shrink-0"
                              style={{ color: isCorrect ? GREEN : '#9ca3af' }}
                            >
                              {optionLabel(optIdx)}
                            </span>
                            <input
                              type="text"
                              value={opt}
                              onChange={e => updateOption(q.id, optIdx, e.target.value)}
                              placeholder={`Option ${optionLabel(optIdx)}`}
                              className="flex-1 border rounded px-3 py-1.5 text-sm text-gray-900"
                              style={{ borderColor: isCorrect ? GREEN : '#d1d5db' }}
                            />
                            <button
                              type="button"
                              onClick={() => removeOption(q.id, optIdx)}
                              disabled={q.options.length <= MIN_OPTIONS}
                              className="text-red-400 hover:text-red-600 disabled:opacity-20 text-sm flex-shrink-0 w-5"
                              title={q.options.length <= MIN_OPTIONS ? `A question needs at least ${MIN_OPTIONS} options` : 'Remove option'}
                            >✕</button>
                          </div>
                        )
                      })}
                    </div>

                    {q.options.length < MAX_OPTIONS && (
                      <button
                        type="button"
                        onClick={() => addOption(q.id)}
                        className="mt-2 text-xs underline"
                        style={{ color: ORANGE }}
                      >
                        + Add option
                      </button>
                    )}
                  </div>

                  {/* Explanation */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Explanation (optional — shown after the student answers)
                    </label>
                    <textarea
                      value={q.explanation}
                      onChange={e => updateQuestion(q.id, 'explanation', e.target.value)}
                      placeholder="Why is this the correct answer?"
                      rows={2}
                      className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-900 resize-none"
                    />
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addQuestion}
                className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 hover:border-orange-300 w-full justify-center"
              >
                + Add question
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 flex-shrink-0">
          {error ? <p className="text-sm text-red-500 pr-4">{error}</p> : <span />}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || loadError !== null}
              className="px-5 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
              style={{ backgroundColor: ORANGE }}
            >
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Activity'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
