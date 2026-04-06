'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Volume2, CheckCircle, XCircle, ChevronRight } from 'lucide-react'

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

interface Sheet {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
  content: { words?: VocabWord[] } | null
}

interface Props {
  studentId: string
  sheet: Sheet
  exercises: Exercise[]
  assignmentId: string | null
  alreadyCompleted: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function DifficultyIcons({ level }: { level: number }) {
  return (
    <span>
      {Array.from({ length: 3 }).map((_, i) => (
        <span key={i} style={{ color: i < level ? '#FF8303' : '#d1d5db' }}>
          🌶️
        </span>
      ))}
    </span>
  )
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

  // Which view is active — vocabulary list or exercises
  const [activeTab, setActiveTab] = useState<'vocab' | 'exercises'>('vocab')

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

  const words: VocabWord[] = sheet.content?.words ?? []
  const currentExercise = exercises[currentExerciseIdx]
  const totalExercises = exercises.length

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
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-3xl">
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
          <span
            className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
            style={
              sheet.category === 'Vocabulary'
                ? { backgroundColor: '#fff7ed', color: '#c2410c' }
                : { backgroundColor: '#eff6ff', color: '#1d4ed8' }
            }
          >
            {sheet.category}
          </span>
          <span className="text-sm text-gray-500">{sheet.level}</span>
          <DifficultyIcons level={sheet.difficulty ?? 1} />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{sheet.title}</h1>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-2 border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('vocab')}
          className="pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'vocab'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303' }
              : { color: '#6b7280', borderBottom: '2px solid transparent' }
          }
        >
          Vocabulary List
          {words.length > 0 && (
            <span className="ml-1.5 text-xs text-gray-400">({words.length})</span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('exercises')}
          className="pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'exercises'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303' }
              : { color: '#6b7280', borderBottom: '2px solid transparent' }
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
            <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
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
                        {/* Audio button — placeholder; wire up TTS if added later */}
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
            <div className="mt-6 p-4 rounded-xl border border-orange-100 bg-orange-50 flex items-center justify-between">
              <p className="text-sm text-gray-700">
                Ready to test yourself? There are <strong>{totalExercises}</strong> exercises for this sheet.
              </p>
              <button
                onClick={() => setActiveTab('exercises')}
                className="ml-4 flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                style={{ backgroundColor: '#FF8303' }}
              >
                Start Exercises <ChevronRight size={14} />
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
              <CheckCircle size={48} className="mx-auto mb-4 text-green-500" />
              <h2 className="text-xl font-bold text-gray-900 mb-2">Well done!</h2>
              <p className="text-sm text-gray-500 mb-1">
                You answered{' '}
                <strong>
                  {correctCount} out of {totalExercises}
                </strong>{' '}
                correctly.
              </p>
              <p className="text-sm text-gray-500 mb-6">
                Score:{' '}
                <strong style={{ color: '#FF8303' }}>
                  {Math.round((correctCount / totalExercises) * 100)}%
                </strong>
              </p>
              <button
                onClick={() => router.back()}
                className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white"
                style={{ backgroundColor: '#FF8303' }}
              >
                Back to Study
              </button>
            </div>
          ) : alreadyCompleted ? (
            /* ── Already completed notice ── */
            <div className="mb-6 p-4 rounded-xl border border-green-100 bg-green-50 flex items-center gap-3">
              <CheckCircle size={18} className="text-green-600 flex-shrink-0" />
              <p className="text-sm text-gray-700">
                You have already completed this sheet. You can redo the exercises for practice — your score will not be recorded again.
              </p>
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
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
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
                  style={{ backgroundColor: '#fffbeb', borderLeft: '3px solid #FFB942' }}
                >
                  <p className="font-semibold text-amber-800 mb-1">Explanation</p>
                  <p className="text-amber-900">{currentExercise.explanation}</p>
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
    </div>
  )
}
