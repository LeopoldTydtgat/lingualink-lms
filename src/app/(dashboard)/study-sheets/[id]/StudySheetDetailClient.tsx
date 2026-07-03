'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer'
import { saveLessonAnnotations } from '@/lib/lessons/saveLessonAnnotations'

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
  category: string
  level: string
  difficulty: number
  content: { words: Word[] }
  attachments: Attachment[] | null
}

type Props = {
  sheet: StudySheet
  exercises: Exercise[]
  isAdmin: boolean
  annotationsByName: Record<string, Annotation[]>
}

// Trailing-debounce interval for annotation autosave. A burst of pen strokes
// collapses into one write this many ms after the teacher pauses.
const AUTOSAVE_DEBOUNCE_MS = 800

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

function categoryBadgeStyle(category: string): React.CSSProperties {
  if (category === 'Vocabulary') return { backgroundColor: '#fff7ed', color: '#c2410c' }
  if (category === 'Grammar') return { backgroundColor: '#eff6ff', color: '#1d4ed8' }
  return { backgroundColor: '#e0f2fe', color: '#0369a1' }
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

// Wraps PdfViewer with live-lesson annotation autosave for the teacher portal.
// One instance per PDF attachment, so each carries its own debounce timer and
// its own "not saving" cue — no idx-keyed map needed.
function AnnotatablePdf({
  fileUrl,
  studySheetId,
  attachmentIndex,
  attachmentName,
  initialAnnotations,
}: {
  fileUrl: string
  studySheetId: string
  attachmentIndex: number
  attachmentName: string
  initialAnnotations?: Annotation[]
}) {
  // Debounce timer + the latest committed annotations pending a write.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<Annotation[] | null>(null)
  // Serialises saves for THIS attachment: every flush chains off the previous one
  // so two upserts to the same (lesson, sheet, attachment) row are never in flight
  // at once. Without this, a slow earlier save and a newer save can race and
  // reorder, letting the older/smaller array commit last and silently drop the
  // most recent marks — a fail-safe violation. Chaining guarantees the last-issued
  // save is the last to write. The chained callback never rejects (it try/catches
  // internally), so the chain can never break.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  // Minimal fail-safe cue. Only 'not_saving' (a write refused during a live
  // class), an unexpected/absent status, or a transport error shows the warning,
  // so marks are never silently discarded on a real failure. 'no_live_class' (the
  // common prep-time / between-classes case) maps to 'idle' and is silent, as are
  // 'saved' and 'idle'; none render a badge.
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'not-saving'>('idle')

  // Persist the latest committed annotations to whichever lesson is live now.
  // saveLessonAnnotations resolves the live lesson itself (W2 — the browser sends
  // NO lessonId) and writes on the user-scoped client (W1). We consume only the
  // returned status to drive the indicator. Queued on saveChainRef so saves for
  // this attachment run strictly in order (see the ref's note above).
  const flush = useCallback(() => {
    const annotations = latestRef.current
    if (annotations === null) return
    latestRef.current = null
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const r = await saveLessonAnnotations({ studySheetId, attachmentIndex, attachmentName, annotations })
        // Map each declared status explicitly. Only an exact 'saved' clears the
        // warning; 'no_live_class' is the benign common case (prep time / between
        // classes) and stays silent; 'not_saving' is a real refusal during a live
        // class. The warn-by-default branch means any unknown/absent status is
        // treated as not-saved (fail-safe), never silently ignored. NOTE: the
        // status values use underscores, but saveState uses a hyphen.
        switch (r?.status) {
          case 'saved':
            setSaveState('saved')
            break
          case 'no_live_class':
            setSaveState('idle')
            break
          case 'not_saving':
            setSaveState('not-saving')
            break
          default:
            setSaveState('not-saving')
        }
      } catch {
        // A transport error is a harmless no-op for persistence, but for the
        // indicator it counts as not-saved (fail-safe): show the warning.
        setSaveState('not-saving')
      }
    })
  }, [studySheetId, attachmentIndex, attachmentName])

  // Trailing debounce: reset the timer on every committed change so a burst of
  // pen strokes collapses into one write. Never fires for the seed or an
  // in-progress draft — PdfViewer only calls this for committed changes.
  function handleAnnotationsChange(annotations: Annotation[]) {
    latestRef.current = annotations
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      flush()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  // On unmount (e.g. navigating away mid-class), flush any pending write so the
  // final marks are not lost with the debounce timer.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        flush()
      }
    }
  }, [flush])

  return (
    <div style={{ position: 'relative' }}>
      <PdfViewer
        fileUrl={fileUrl}
        initialAnnotations={initialAnnotations}
        onAnnotationsChange={handleAnnotationsChange}
      />
      {saveState === 'not-saving' && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 10,
            pointerEvents: 'none',
            backgroundColor: '#FFFBEB',
            color: '#92400E',
            border: '1px solid #FDE68A',
            borderRadius: 6,
            padding: '2px 8px',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Not saving — check your connection
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
    <div className="mb-6 space-y-4">
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
            className="border border-gray-200 rounded-xl overflow-hidden bg-white"
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

export default function StudySheetDetailClient({ sheet, exercises, isAdmin, annotationsByName }: Props) {
  const router = useRouter()
  const words: Word[] = sheet.content?.words ?? []
  const attachments = sheet.attachments ?? []

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
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={categoryBadgeStyle(sheet.category)}
              >
                {sheet.category}
              </span>
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
              >
                {sheet.level}
              </span>
              {sheet.difficulty != null && <DifficultyBars count={sheet.difficulty} />}
            </div>
          </div>
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
