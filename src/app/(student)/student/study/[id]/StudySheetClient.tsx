'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Volume2, CheckCircle, XCircle, ChevronRight, RotateCcw } from 'lucide-react'
import MaterialFileViewer from '@/components/study/MaterialFileViewer'
import DifficultyBars from '@/components/study/DifficultyBars'
import { categoryBadgeStyle } from '@/lib/study/categoryBadge'

// ── Types ────────────────────────────────────────────────────────────────────

interface VocabWord {
  word: string
  part_of_speech: string
  definition: string
  example: string
}

interface Exercise {
  id: string
  question_text: string
  options: string[]           // JSON array of answer options
  correct_answer: string      // The correct option text
  explanation: string
  duration_minutes: number | null
}

interface Attachment {
  name: string
  url: string
  type: string
}

interface Sheet {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  content: { words?: VocabWord[] } | null
  attachments: Attachment[] | null
}

interface Props {
  studentId: string
  sheet: Sheet
  exercises: Exercise[]
  assignmentId: string | null
  alreadyCompleted: boolean
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StudySheetClient({
  studentId,
  sheet,
  exercises,
  assignmentId,
  alreadyCompleted,
}: Props) {
  const router = useRouter()

  const words: VocabWord[] = sheet.content?.words ?? []

  // Which view is active — vocabulary list or exercises. Default to the vocab
  // tab only when the sheet has words; otherwise open straight to exercises.
  const [activeTab, setActiveTab] = useState<'vocab' | 'exercises'>(
    words.length > 0 ? 'vocab' : 'exercises'
  )

  // Exercise state
  const [currentExerciseIdx, setCurrentExerciseIdx] = useState(0)
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [answeredCorrectly, setAnsweredCorrectly] = useState<boolean | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)
  const [correctCount, setCorrectCount] = useState(0)
  const [completedExercises, setCompletedExercises] = useState<Set<number>>(new Set())
  const [sessionComplete, setSessionComplete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [markingDone, setMarkingDone] = useState(false)
  const [markedDone, setMarkedDone] = useState(false)
  const [markError, setMarkError] = useState('')

  const currentExercise = exercises[currentExerciseIdx]
  const totalExercises = exercises.length
  const scorePct = totalExercises > 0 ? Math.round((correctCount / totalExercises) * 100) : 100

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleSelectAnswer(option: string) {
    if (selectedAnswer !== null) return // already answered this question

    const correct = option === currentExercise.correct_answer
    setSelectedAnswer(option)
    setAnsweredCorrectly(correct)
    setShowExplanation(true)

    if (correct) {
      setCorrectCount((prev) => prev + 1)
    }

    setCompletedExercises((prev) => new Set(prev).add(currentExerciseIdx))
  }

  function handleNextExercise() {
    if (currentExerciseIdx < totalExercises - 1) {
      setCurrentExerciseIdx((prev) => prev + 1)
      setSelectedAnswer(null)
      setAnsweredCorrectly(null)
      setShowExplanation(false)
    } else {
      // All exercises done — save completion
      handleFinishExercises()
    }
  }

  async function handleFinishExercises() {
    setSaving(true)
    setSaveError('')

    try {
      const score = totalExercises > 0 ? Math.round((correctCount / totalExercises) * 100) : 100

      const res = await fetch('/api/student/exercise-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId,
          sheetId: sheet.id,
          assignmentId: assignmentId ?? null,
          score,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to save progress')
      }

      setSessionComplete(true)
      router.refresh()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  // Reset the in-progress exercise run only — never touches exercise_completions.
  function handleTryAgain() {
    setCurrentExerciseIdx(0)
    setSelectedAnswer(null)
    setAnsweredCorrectly(null)
    setShowExplanation(false)
    setCorrectCount(0)
    setCompletedExercises(new Set())
    setSessionComplete(false)
    setSaveError('')
  }

  // Mark the whole sheet as done — independent of the exercise flow. Works for
  // any sheet (vocabulary, grammar, or zero exercises).
  async function handleMarkAsDone() {
    setMarkingDone(true)
    setMarkError('')

    try {
      const res = await fetch('/api/student/exercise-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId,
          sheetId: sheet.id,
          assignmentId: assignmentId ?? null,
          score: null,
        }),
      })

      if (res.ok) {
        setMarkedDone(true)
        router.refresh()
        return
      }

      // A duplicate completion is reported as a success signal, not a hard error.
      const data = await res.json().catch(() => ({}))
      if (data.alreadyCompleted) {
        setMarkedDone(true)
        router.refresh()
      } else {
        setMarkError(data.error ?? 'Failed to mark as done')
      }
    } catch (err: unknown) {
      setMarkError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setMarkingDone(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Study
      </button>

      {/* Sheet header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          {sheet.category && (
            <span
              className="px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize"
              style={categoryBadgeStyle(sheet.category)}
            >
              {sheet.category}
            </span>
          )}
          {sheet.level && <span className="text-sm text-gray-500">{sheet.level}</span>}
          {sheet.difficulty != null && <DifficultyBars count={sheet.difficulty} />}
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{sheet.title}</h1>
      </div>

      {/* File viewer — shown whenever the sheet has attachments, before the tabs */}
      {(sheet.attachments?.length ?? 0) > 0 && (
        <MaterialFileViewer
          attachments={sheet.attachments ?? []}
          sheetId={sheet.id}
          mode="plain"
          wrapperClassName="mb-6 space-y-4"
          cardClassName="border border-gray-200 rounded-xl overflow-hidden bg-white"
          cardStyle={{}}
        />
      )}

      {/* Tab toggle */}
      <div className="flex gap-2 border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('vocab')}
          className="flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'vocab'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '160px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '160px' }
          }
        >
          Vocabulary List
          {words.length > 0 && (
            <span className="ml-1.5 text-xs text-gray-400">({words.length})</span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('exercises')}
          className="flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'exercises'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '160px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '160px' }
          }
        >
          Exercises
          {totalExercises > 0 && (
            <span className="ml-1.5 text-xs text-gray-400">({totalExercises})</span>
          )}
        </button>
      </div>

      {/* ── VOCABULARY TAB ──────────────────────────────────────────────── */}
      {activeTab === 'vocab' && (
        <div>
          {words.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              No vocabulary words added to this sheet yet.
            </p>
          ) : (
            <div className="rounded-xl overflow-hidden bg-white shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Word</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 hidden sm:table-cell">
                      Part of Speech
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Definition</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 hidden md:table-cell">
                      Example
                    </th>
                    <th className="px-4 py-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {words.map((w, idx) => (
                    <tr
                      key={idx}
                      className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                      style={{ borderBottom: '1px solid #f3f4f6' }}
                    >
                      <td className="px-4 py-3 font-semibold text-gray-900">{w.word}</td>
                      <td className="px-4 py-3 text-gray-500 italic hidden sm:table-cell">
                        {w.part_of_speech}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{w.definition}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{w.example}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => {
                            if ('speechSynthesis' in window) {
                              const utt = new SpeechSynthesisUtterance(w.word)
                              utt.lang = 'en-GB'
                              window.speechSynthesis.speak(utt)
                            }
                          }}
                          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                          title={`Hear pronunciation of "${w.word}"`}
                        >
                          <Volume2 size={14} className="text-gray-400" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Prompt to do exercises */}
          {totalExercises > 0 && (
            <div
              className="mt-6 p-4 rounded-xl flex items-center justify-between"
              style={
                alreadyCompleted
                  ? { border: '1px solid #f3f4f6', backgroundColor: '#f9fafb' }
                  : { border: '1px solid #ffedd5', backgroundColor: '#fff7ed' }
              }
            >
              <p className="text-sm text-gray-700">
                Ready to test yourself?{' '}
                {totalExercises === 1 ? (
                  <>There is <strong>1</strong> exercise for this sheet.</>
                ) : (
                  <>There are <strong>{totalExercises}</strong> exercises for this sheet.</>
                )}
              </p>
              <button
                onClick={() => setActiveTab('exercises')}
                className="ml-4 flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold"
                style={
                  alreadyCompleted
                    ? { backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8' }
                    : { backgroundColor: '#FF8303', color: '#ffffff' }
                }
              >
                {alreadyCompleted ? 'Redo Exercises' : 'Start Exercises'} <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── EXERCISES TAB ───────────────────────────────────────────────── */}
      {activeTab === 'exercises' && (
        <div>
          {totalExercises === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              No exercises for this sheet yet.
            </p>
          ) : sessionComplete ? (
            /* ── Completion screen ── */
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
                  {correctCount} out of {totalExercises}
                </strong>{' '}
                correctly.
              </p>
              <p className={`text-sm text-gray-500 ${scorePct < 60 ? 'mb-1' : 'mb-6'}`}>
                Score:{' '}
                <strong style={{ color: '#FF8303' }}>
                  {scorePct}%
                </strong>
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
                  onClick={() => router.back()}
                  className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  Back to Study
                </button>
              </div>
            </div>
          ) : null}

          {/* Exercise card — shown when not in completion state */}
          {!sessionComplete && totalExercises > 0 && (
            <div>
              {/* Progress bar */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">
                  Question {currentExerciseIdx + 1} of {totalExercises}
                </span>
                <span className="text-xs text-gray-500">
                  {completedExercises.size} answered
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-gray-200 mb-6">
                <div
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: `${(completedExercises.size / totalExercises) * 100}%`,
                    backgroundColor: '#FF8303',
                  }}
                />
              </div>

              {/* Question */}
              <div className="bg-white rounded-xl p-5 mb-4 shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
                <p className="font-semibold text-gray-900 text-base leading-snug mb-5">
                  {currentExercise.question_text}
                </p>

                {/* Answer options */}
                <div className="flex flex-col gap-2">
                  {(currentExercise.options ?? []).map((option, i) => {
                    const isSelected = selectedAnswer === option
                    const isCorrect = option === currentExercise.correct_answer
                    const hasAnswered = selectedAnswer !== null

                    let borderColor = '#e5e7eb'
                    let bgColor = '#ffffff'
                    let textColor = '#374151'

                    if (hasAnswered) {
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
                        onClick={() => handleSelectAnswer(option)}
                        disabled={hasAnswered}
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
                        {hasAnswered && isCorrect && (
                          <CheckCircle size={14} className="ml-auto text-green-600" />
                        )}
                        {hasAnswered && isSelected && !isCorrect && (
                          <XCircle size={14} className="ml-auto text-red-500" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Explanation box — shown after answering */}
              {showExplanation && currentExercise.explanation && (
                <div
                  className="p-4 rounded-xl mb-4 text-sm"
                  style={
                    answeredCorrectly
                      ? { backgroundColor: '#f0fdf4', borderLeft: '3px solid #bbf7d0' }
                      : { backgroundColor: '#FFF5F0', borderLeft: '3px solid #FD5602' }
                  }
                >
                  <p
                    className="font-semibold mb-1"
                    style={{ color: answeredCorrectly ? '#15803d' : '#FD5602' }}
                  >
                    {answeredCorrectly
                      ? 'Correct!'
                      : `Not quite — the answer is '${currentExercise.correct_answer}'`}
                  </p>
                  <p className="text-gray-700">{currentExercise.explanation}</p>
                </div>
              )}

              {/* Error message */}
              {saveError && (
                <p className="text-sm text-red-600 mb-4">{saveError}</p>
              )}

              {/* Next / Finish button */}
              {selectedAnswer !== null && (
                <button
                  onClick={handleNextExercise}
                  disabled={saving}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  {saving
                    ? 'Saving...'
                    : currentExerciseIdx < totalExercises - 1
                    ? 'Next Question'
                    : 'Finish'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mark as done — completion path independent of the exercises */}
      {alreadyCompleted || markedDone || sessionComplete ? (
        <div
          className="mt-8 p-4 rounded-xl flex items-start gap-3"
          style={{ backgroundColor: '#f0fdf4', border: '1px solid #f3f4f6', borderLeft: '3px solid #16A34A' }}
        >
          <CheckCircle size={18} className="text-green-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-green-700">Completed</p>
            {totalExercises > 0 && (
              <p className="text-xs text-gray-600 mt-0.5">
                You can redo the exercises for practice — your score will not be recorded again.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-8">
          <button
            onClick={handleMarkAsDone}
            disabled={markingDone}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#FF8303' }}
          >
            {markingDone ? 'Saving...' : 'Mark as done'}
          </button>
          {markError && (
            <p className="text-sm text-red-600 mt-2">{markError}</p>
          )}
        </div>
      )}
    </div>
  )
}
