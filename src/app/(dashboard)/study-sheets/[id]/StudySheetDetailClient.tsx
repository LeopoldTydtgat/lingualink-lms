'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Word = {
  word: string
  part_of_speech: string
  definition: string
  example: string
}

type Exercise = {
  id: string
  question_text: string
  options: string[]
  correct_answer: string
  explanation: string
  duration_minutes: number
}

type StudySheet = {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
  content: { words: Word[] }
}

type Props = {
  sheet: StudySheet
  exercises: Exercise[]
  isAdmin: boolean
}

function DifficultyDots({ count }: { count: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
      {[1, 2, 3].map(n => (
        <span key={n} style={{ color: n <= count ? '#FF8303' : '#e5e7eb', fontSize: '15px', lineHeight: 1 }}>●</span>
      ))}
    </span>
  )
}

function ExerciseCard({ exercise }: { exercise: Exercise }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)

  const answered = selected !== null

  return (
    <div className="border border-gray-200 rounded-xl p-5 bg-white">
      <p className="font-medium text-gray-900 mb-4">{exercise.question_text}</p>

      <div className="space-y-2 mb-4">
        {exercise.options.map((option) => {
          const isCorrect = option === exercise.correct_answer
          const isSelected = option === selected

          let bgColor = 'white'
          let borderColor = '#e5e7eb'
          let textColor = '#374151'

          if (answered) {
            if (isCorrect) {
              bgColor = '#f0fdf4'
              borderColor = '#22c55e'
              textColor = '#15803d'
            } else if (isSelected && !isCorrect) {
              bgColor = '#fef2f2'
              borderColor = '#ef4444'
              textColor = '#b91c1c'
            }
          } else if (isSelected) {
            borderColor = '#FF8303'
          }

          return (
            <button
              key={option}
              onClick={() => {
                if (!answered) {
                  setSelected(option)
                  setShowExplanation(true)
                }
              }}
              className="w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors"
              style={{ backgroundColor: bgColor, borderColor, color: textColor }}
            >
              {option}
            </button>
          )
        })}
      </div>

      {/* Explanation box — amber, shown after answering */}
      {answered && (
        <div
          className="rounded-lg p-4 text-sm"
          style={{ backgroundColor: '#FFFBEB', borderLeft: '4px solid #FFB942' }}
        >
          <button
            onClick={() => setShowExplanation(!showExplanation)}
            className="flex items-center justify-between w-full font-medium text-amber-800"
          >
            <span>Explanation</span>
            {showExplanation ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showExplanation && (
            <p className="mt-2 text-amber-700">{exercise.explanation}</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function StudySheetDetailClient({ sheet, exercises, isAdmin }: Props) {
  const router = useRouter()
  const words: Word[] = sheet.content?.words ?? []

  return (
    <div className="p-6 max-w-4xl mx-auto">

      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Study Sheets
      </button>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">{sheet.title}</h1>
            <div className="flex items-center gap-3">
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
              >
                {sheet.category}
              </span>
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
              >
                {sheet.level}
              </span>
              <DifficultyDots count={sheet.difficulty} />
            </div>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              onClick={() => router.push(`/study-sheets/${sheet.id}/edit`)}
            >
              Edit Sheet
            </Button>
          )}
        </div>
      </div>

      {/* Vocabulary table */}
      {words.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Vocabulary List</h2>
            <p className="text-sm text-gray-500 mt-0.5">{words.length} words</p>
          </div>
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Word</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Part of Speech</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Definition</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Example</th>
              </tr>
            </thead>
            <tbody>
              {words.map((word, i) => (
                <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900 text-sm">{word.word}</td>
                  <td className="px-6 py-4 text-sm text-gray-500 italic">{word.part_of_speech}</td>
                  <td className="px-6 py-4 text-sm text-gray-700">{word.definition}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">&ldquo;{word.example}&rdquo;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Exercises section */}
      <div>
        <h2 className="font-semibold text-gray-900 mb-4">
          Exercises
          <span className="ml-2 text-sm font-normal text-gray-400">({exercises.length})</span>
        </h2>

        {exercises.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center text-gray-400 text-sm">
            No exercises added yet for this study sheet.
          </div>
        ) : (
          <div className="space-y-4">
            {exercises.map((ex) => (
              <ExerciseCard key={ex.id} exercise={ex} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
