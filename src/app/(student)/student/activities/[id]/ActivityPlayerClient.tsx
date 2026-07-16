'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle, XCircle, RotateCcw } from 'lucide-react'
import type { McqQuestion } from '@/lib/validation/activities'

// ── Types ────────────────────────────────────────────────────────────────────

interface QuestionResult {
  correct: boolean
  correct_answer: string
  explanation: string | null
}

interface Props {
  activityId: string
  title: string | null
  questions: McqQuestion[]
  previousScore: number | null
}

// Phase 1 collects answers; phase 2 walks the graded results; then the score.
// Correct answers exist client-side only after the grade response arrives.
type Phase = 'answering' | 'review' | 'score'

// ── Main Component ───────────────────────────────────────────────────────────

export default function ActivityPlayerClient({
  activityId,
  title,
  questions,
  previousScore,
}: Props) {
  const router = useRouter()

  const [phase, setPhase] = useState<Phase>('answering')
  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, QuestionResult> | null>(null)
  const [score, setScore] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const total = questions.length

  // questions is min(1) by schema and the page validates before rendering, so
  // index 0 always exists. Clamping guards the case where router.refresh()
  // delivers a shorter question set while currentIdx is still client state —
  // an unclamped questions[currentIdx] would be undefined and crash the player.
  const activeIdx = Math.min(currentIdx, total - 1)
  const currentQuestion = questions[activeIdx]
  const currentResult = results?.[currentQuestion.id] ?? null
  const answeredCount = questions.filter(q => answers[q.id] !== undefined).length
  const allAnswered = answeredCount === total
  const isLast = activeIdx === total - 1
  const correctCount = results
    ? Object.values(results).filter(r => r.correct).length
    : 0

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleSelect(option: string) {
    if (phase !== 'answering') return
    setAnswers(prev => ({ ...prev, [currentQuestion.id]: option }))
  }

  function goNext() {
    if (activeIdx < total - 1) setCurrentIdx(activeIdx + 1)
  }

  function goBack() {
    if (activeIdx > 0) setCurrentIdx(activeIdx - 1)
  }

  // Grading is server-side. The client never sees a correct answer until this
  // response lands.
  async function handleSubmit() {
    setSubmitting(true)
    setSubmitError('')

    try {
      const res = await fetch(`/api/student/activities/${activityId}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to submit your answers')
      }

      setResults(data.results ?? {})
      setScore(typeof data.score === 'number' ? data.score : null)
      setPhase('review')
      setCurrentIdx(0)
      router.refresh()
    } catch (err: unknown) {
      // Answers stay in state — the student retries without re-entering them.
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  // A fresh run. The next submit records a new attempt row — intended.
  function handleTryAgain() {
    setPhase('answering')
    setCurrentIdx(0)
    setAnswers({})
    setResults(null)
    setScore(null)
    setSubmitError('')
  }

  // Re-entering review must rewind — the score screen is only ever reached
  // from the last question, so without this it reopens on the last question
  // with a 'See Score' button, straight back where the student came from.
  function handleReviewAgain() {
    setCurrentIdx(0)
    setPhase('review')
  }

  // ── Score screen ───────────────────────────────────────────────────────────

  if (phase === 'score') {
    const scorePct = score ?? 0

    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>

        <div className="text-center py-12">
          {scorePct >= 60 ? (
            <>
              <CheckCircle size={48} className="mx-auto mb-4 text-green-500" />
              <h2 className="text-xl font-bold text-gray-900 mb-2">Well done!</h2>
            </>
          ) : (
            <>
              <RotateCcw size={48} className="mx-auto mb-4" style={{ color: '#FFB942' }} />
              <h2 className="text-xl font-bold text-gray-900 mb-2">Keep practising!</h2>
            </>
          )}
          <p className="text-sm text-gray-500 mb-1">
            You answered{' '}
            <strong>
              {correctCount} out of {total}
            </strong>{' '}
            correctly.
          </p>
          <p className={`text-sm text-gray-500 ${scorePct < 60 ? 'mb-1' : 'mb-6'}`}>
            Score: <strong style={{ color: '#FF8303' }}>{scorePct}%</strong>
          </p>
          {scorePct < 60 && (
            <p className="text-sm text-gray-500 mb-6">
              Review the sheet and try again — practice makes progress.
            </p>
          )}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleTryAgain}
              className="px-6 py-2.5 rounded-lg text-sm font-semibold"
              style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC', color: '#FF8303' }}
            >
              Try Again
            </button>
            <button
              onClick={handleReviewAgain}
              className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              Review Answers
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Answering / review ─────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{title ?? 'Activity'}</h1>
        {phase === 'answering' && activeIdx === 0 && previousScore !== null && (
          <p className="text-sm text-gray-500 mt-1">
            Previous score: <strong style={{ color: '#FF8303' }}>{previousScore}%</strong>
          </p>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">
          Question {activeIdx + 1} of {total}
        </span>
        <span className="text-xs text-gray-500">
          {phase === 'review' ? 'Reviewing answers' : `${answeredCount} answered`}
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-gray-200 mb-6">
        <div
          className="h-1.5 rounded-full transition-all"
          style={{
            width: `${
              phase === 'review'
                ? ((activeIdx + 1) / total) * 100
                : (answeredCount / total) * 100
            }%`,
            backgroundColor: '#FF8303',
          }}
        />
      </div>

      {/* Question */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
        <p className="font-semibold text-gray-900 text-base leading-snug mb-5">
          {currentQuestion.question_text}
        </p>

        <div className="flex flex-col gap-2">
          {currentQuestion.options.map((option, i) => {
            const isSelected = answers[currentQuestion.id] === option
            // Only ever non-null in the review phase, from the server response.
            const isCorrect =
              currentResult !== null &&
              option.trim() === currentResult.correct_answer.trim()
            const isGraded = phase === 'review' && currentResult !== null

            let borderColor = '#e5e7eb'
            let bgColor = '#ffffff'
            let textColor = '#374151'

            if (isGraded) {
              if (isCorrect) {
                borderColor = '#16a34a'
                bgColor = '#f0fdf4'
                textColor = '#15803d'
              } else if (isSelected && !isCorrect) {
                borderColor = '#dc2626'
                bgColor = '#fef2f2'
                textColor = '#dc2626'
              }
            } else if (isSelected) {
              borderColor = '#FF8303'
              bgColor = '#fff7ed'
            }

            return (
              <button
                key={i}
                onClick={() => handleSelect(option)}
                disabled={isGraded}
                className="flex items-center gap-3 px-4 py-3 rounded-lg text-left text-sm font-medium transition-all border"
                style={{ borderColor, backgroundColor: bgColor, color: textColor }}
              >
                <span
                  className="flex-shrink-0 w-6 h-6 rounded-full border flex items-center justify-center text-xs font-bold"
                  style={{ borderColor, color: textColor }}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                {option}
                {isGraded && isCorrect && (
                  <CheckCircle size={14} className="ml-auto text-green-600" />
                )}
                {isGraded && isSelected && !isCorrect && (
                  <XCircle size={14} className="ml-auto text-red-500" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Result + explanation — review phase only */}
      {phase === 'review' && currentResult && (
        <div className="mb-4">
          <p
            className="text-sm font-semibold mb-2"
            style={{ color: currentResult.correct ? '#15803d' : '#dc2626' }}
          >
            {currentResult.correct
              ? 'Correct!'
              : `Not quite — the answer is '${currentResult.correct_answer}'`}
          </p>
          {currentResult.explanation && (
            <div
              className="p-4 rounded-xl text-sm"
              style={{ backgroundColor: '#fffbeb', borderLeft: '3px solid #FFB942' }}
            >
              <p className="text-gray-700">{currentResult.explanation}</p>
            </div>
          )}
        </div>
      )}

      {submitError && <p className="text-sm text-red-600 mb-4">{submitError}</p>}

      {/* Navigation */}
      <div className="flex items-center gap-3">
        {activeIdx > 0 && (
          <button
            onClick={goBack}
            disabled={submitting}
            className="px-6 py-3 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC', color: '#FF8303' }}
          >
            Previous
          </button>
        )}

        {phase === 'answering' ? (
          isLast ? (
            <button
              onClick={handleSubmit}
              disabled={!allAnswered || submitting}
              className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#FF8303' }}
            >
              {submitting ? 'Submitting...' : 'Submit Answers'}
            </button>
          ) : (
            <button
              onClick={goNext}
              className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#FF8303' }}
            >
              Next
            </button>
          )
        ) : (
          <button
            onClick={() => (isLast ? setPhase('score') : goNext())}
            className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#FF8303' }}
          >
            {isLast ? 'See Score' : 'Next'}
          </button>
        )}
      </div>
    </div>
  )
}
