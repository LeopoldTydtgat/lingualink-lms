'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LEN = 10000
const ORANGE = '#FF8303'
// Design-system card: white, soft shadow, hairline border, rounded-xl.
const CARD_BORDER = '1px solid #f3f4f6'

// Date only. Intl.DateTimeFormat is the project's sanctioned formatter —
// toLocaleTimeString and toISOString-for-local-dates are both banned.
const submittedDateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

// ── Types ────────────────────────────────────────────────────────────────────

interface LatestAttempt {
  responseText: string
  teacherFeedback: string | null
  needsReview: boolean
  // '' means an optimistic just-submitted attempt with no server timestamp yet.
  createdAt: string
}

interface Props {
  activityId: string
  assignmentId: string | null
  title: string | null
  prompt: string
  latestAttempt: LatestAttempt | null
}

// ── Component ────────────────────────────────────────────────────────────────

export default function WritingTaskPlayerClient({
  activityId,
  assignmentId,
  title,
  prompt,
  latestAttempt,
}: Props) {
  const router = useRouter()

  // The attempt currently on show. Seeded from the server, then replaced locally
  // on a successful submit so the view updates immediately — router.refresh()
  // reconciles server data but never re-runs these useState initialisers.
  const [shown, setShown] = useState<LatestAttempt | null>(latestAttempt)
  // The editor is open when there is nothing submitted yet.
  const [isWriting, setIsWriting] = useState(latestAttempt === null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const trimmed = text.trim()
  const canSubmit = trimmed.length > 0 && text.length <= MAX_LEN && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')

    try {
      const res = await fetch(`/api/student/activities/${activityId}/submit-writing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_text: text, assignment_id: assignmentId ?? undefined }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to submit your response')
      }

      // Optimistic local view: a fresh writing attempt always awaits review and
      // carries no feedback yet. createdAt is left '' → shown as "just now"
      // until the next full load surfaces the server timestamp.
      setShown({ responseText: trimmed, teacherFeedback: null, needsReview: true, createdAt: '' })
      setIsWriting(false)
      setText('')
      router.refresh()
    } catch (err: unknown) {
      // Text stays in state so the student can retry without retyping.
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  function startNewResponse() {
    setText('')
    setError('')
    setIsWriting(true)
  }

  function formatSubmitted(iso: string): string {
    if (!iso) return 'just now'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return submittedDateFmt.format(d)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      <h1 className="text-2xl font-bold text-gray-900 mb-5">{title ?? 'Writing task'}</h1>

      {/* Prompt */}
      <div className="bg-white shadow-sm rounded-xl p-5 mb-4" style={{ border: CARD_BORDER }}>
        <p className="text-xs font-semibold uppercase text-gray-400 mb-2">Prompt</p>
        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{prompt}</p>
      </div>

      {isWriting ? (
        <>
          {/* Editor */}
          <div className="bg-white shadow-sm rounded-xl p-5 mb-4" style={{ border: CARD_BORDER }}>
            <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">
              Your response
            </label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={MAX_LEN}
              rows={10}
              placeholder="Write your response here…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none"
            />
            <div className="flex justify-end mt-1">
              <span
                className="text-xs"
                style={{ color: text.length >= MAX_LEN ? '#dc2626' : '#9ca3af' }}
              >
                {text.length} / {MAX_LEN}
              </span>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

          <div className="flex items-center gap-3">
            {shown && (
              <button
                onClick={() => { setIsWriting(false); setError('') }}
                disabled={submitting}
                className="px-6 py-3 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC', color: ORANGE }}
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: ORANGE }}
            >
              {submitting ? 'Submitting…' : 'Submit Response'}
            </button>
          </div>
        </>
      ) : shown ? (
        <>
          {/* Submitted response (read-only) */}
          <div className="bg-white shadow-sm rounded-xl p-5 mb-4" style={{ border: CARD_BORDER }}>
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-semibold uppercase text-gray-400">Your response</p>
              {shown.needsReview && (
                <span
                  className="text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
                  style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}
                >
                  Awaiting teacher review
                </span>
              )}
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
              {shown.responseText}
            </p>
            <p className="text-xs text-gray-400 mt-3">Submitted {formatSubmitted(shown.createdAt)}</p>
          </div>

          {/* Teacher feedback */}
          {shown.teacherFeedback !== null && (
            <div className="bg-white shadow-sm rounded-xl p-5 mb-4" style={{ border: CARD_BORDER }}>
              <p className="text-xs font-semibold uppercase text-gray-400 mb-2">Teacher feedback</p>
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {shown.teacherFeedback}
              </p>
            </div>
          )}

          <button
            onClick={startNewResponse}
            className="px-6 py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: ORANGE }}
          >
            Write a new response
          </button>
        </>
      ) : null}
    </div>
  )
}
