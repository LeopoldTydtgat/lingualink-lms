'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer'
import { saveLessonAnnotations } from '@/lib/lessons/saveLessonAnnotations'

// Trailing-debounce interval for annotation autosave. A burst of pen strokes
// collapses into one write this many ms after the teacher pauses.
const AUTOSAVE_DEBOUNCE_MS = 800

// Wraps PdfViewer with live-lesson annotation autosave for the teacher portal.
// One instance per PDF attachment, so each carries its own debounce timer and
// its own "not saving" cue — no idx-keyed map needed.
export default function AnnotatablePdf({
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
