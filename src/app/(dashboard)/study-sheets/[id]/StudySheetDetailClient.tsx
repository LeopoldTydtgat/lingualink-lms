'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minimize2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type Annotation } from '@/components/pdf/PdfViewer'
import AnnotatablePdf from '@/components/pdf/AnnotatablePdf'

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

type Attachment = {
  name: string
  url: string
  type: string
}

type StudySheet = {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  content: { words: Word[] }
  attachments: Attachment[] | null
}

type Props = {
  sheet: StudySheet
  exercises: Exercise[]
  isAdmin: boolean
  annotationsByName: Record<string, Annotation[]>
  live?: boolean
}

function DifficultyBars({ count }: { count: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '16px' }}>
      {[1, 2, 3].map(n => (
        <span key={n} style={{
          display: 'inline-block',
          width: '5px',
          height: n === 1 ? '6px' : n === 2 ? '10px' : '14px',
          borderRadius: '2px',
          backgroundColor: n <= count ? '#FF8303' : '#e5e7eb',
        }} />
      ))}
    </span>
  )
}

function categoryBadgeStyle(category: string | null): React.CSSProperties {
  if (category === 'Vocabulary') return { backgroundColor: '#fff7ed', color: '#c2410c' }
  if (category === 'Grammar') return { backgroundColor: '#eff6ff', color: '#1d4ed8' }
  return { backgroundColor: '#e0f2fe', color: '#0369a1' }
}

function ExerciseCard({ exercise }: { exercise: Exercise }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)

  const answered = selected !== null

  return (
    <div className="rounded-xl p-5 bg-white shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
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

function MaterialFileViewer({
  attachments,
  sheetId,
  annotationsByName,
}: {
  attachments: Attachment[]
  sheetId: string
  annotationsByName: Record<string, Annotation[]>
}) {
  const containerRefs = useRef<(HTMLDivElement | null)[]>([])
  const [fullscreenIdx, setFullscreenIdx] = useState<number | null>(null)

  useEffect(() => {
    function onFullscreenChange() {
      if (!document.fullscreenElement) {
        setFullscreenIdx(null)
        return
      }
      const idx = containerRefs.current.findIndex(el => el === document.fullscreenElement)
      setFullscreenIdx(idx === -1 ? null : idx)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  function handleFullscreen(idx: number) {
    if (fullscreenIdx === idx) {
      if (typeof document.exitFullscreen === 'function') {
        document.exitFullscreen().catch(() => {})
      }
    } else {
      const el = containerRefs.current[idx]
      if (el && typeof el.requestFullscreen === 'function') {
        el.requestFullscreen().catch(() => {})
      }
    }
  }

  return (
    <div className="space-y-4">
      {attachments.map((att, idx) => {
        const isPdf = att.type === 'application/pdf'
        const isImage = att.type.startsWith('image/')
        // Same-origin proxy URL, served by the auth-gated /api/library-file route.
        const fileUrl = `/api/library-file/${sheetId}/${idx}`
        const isThisFullscreen = fullscreenIdx === idx

        return (
          <div
            key={idx}
            ref={el => { containerRefs.current[idx] = el }}
            className="rounded-xl overflow-hidden bg-white shadow-sm"
            style={{ border: '1px solid #f3f4f6' }}
          >
            <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-gray-500 truncate">{att.name}</span>
              {isImage && (
                <button
                  type="button"
                  onClick={() => handleFullscreen(idx)}
                  className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 transition-opacity hover:opacity-80"
                  style={{ color: '#FF8303', border: '1px solid #FF8303', backgroundColor: '#fff7ed' }}
                  title={isThisFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
                >
                  {isThisFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  {isThisFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                </button>
              )}
            </div>
            {isPdf ? (
              // AnnotatablePdf wraps PdfViewer with live-lesson autosave: it renders
              // the PDF through the same proxy (its own toolbar, NO download/print)
              // and, during a live class, silently persists the teacher's marks.
              <AnnotatablePdf
                fileUrl={fileUrl}
                studySheetId={sheetId}
                attachmentIndex={idx}
                attachmentName={att.name}
                initialAnnotations={annotationsByName[att.name]}
              />
            ) : isImage ? (
              <img
                src={fileUrl}
                alt={att.name}
                style={{ maxWidth: '100%', display: 'block' }}
              />
            ) : (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                Preview is not available for this file type.
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function StudySheetDetailClient({ sheet, exercises, isAdmin, annotationsByName, live = false }: Props) {
  const router = useRouter()
  const words: Word[] = sheet.content?.words ?? []
  const attachments = sheet.attachments ?? []

  return (
    <div className={live ? 'space-y-6 p-6 max-w-5xl mx-auto' : 'space-y-6'}>

      {/* Back button - hidden in the live window (NEW255 c-ii): in the chrome-free
          (live) route it would navigate into the chromed dashboard mid-class. */}
      {!live && (
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Study Sheets
        </button>
      )}

      {/* Header */}
      <div className="bg-white rounded-xl p-6 shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">{sheet.title}</h1>
            <div className="flex items-center gap-3">
              {sheet.category && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium"
                  style={categoryBadgeStyle(sheet.category)}
                >
                  {sheet.category}
                </span>
              )}
              {sheet.level && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
                >
                  {sheet.level}
                </span>
              )}
              {sheet.difficulty != null && <DifficultyBars count={sheet.difficulty} />}
            </div>
          </div>
          {/* Live window entry - prep page only (NEW255 d). Opens the chrome-free
              (live) page in a named popup so the teacher can window-share just the
              PDF in Teams. Hidden in the live window itself via the same {!live} gate. */}
          {!live && (
            <button
              type="button"
              onClick={() => window.open(`/live-annotate/${sheet.id}`, 'live-annotate', 'popup')}
              className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md flex-shrink-0 transition-opacity hover:opacity-80"
              style={{ color: '#FF8303', border: '1px solid #FF8303', backgroundColor: '#fff7ed' }}
              title="Open this sheet in a separate window to screen-share in Teams"
            >
              <ExternalLink className="w-4 h-4" />
              Open Live Window
            </button>
          )}
        </div>
      </div>

      {/* Material file viewer — view-only, no download */}
      {attachments.length > 0 && (
        <MaterialFileViewer
          attachments={attachments}
          sheetId={sheet.id}
          annotationsByName={annotationsByName}
        />
      )}

      {/* Vocabulary table */}
      {words.length > 0 && (
        <div className="bg-white rounded-xl overflow-hidden shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
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
          <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold align-middle" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{exercises.length}</span>
        </h2>

        {exercises.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm px-6 py-12 text-center text-gray-400 text-sm" style={{ border: '1px solid #f3f4f6' }}>
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
