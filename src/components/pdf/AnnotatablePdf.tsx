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
  // common prep-time / between-classes case) maps to 'idle' and is SILENT, and
  // must stay that way: a badge there was a permanent false alarm on every page
  // where no class is live, which is why NEW253 removed it. Do not re-introduce
  // one. 'idle' renders nothing.
  //
  // 'saved' is the only state that changed meaning: a successful write now renders
  // a transient confirmation, which clears itself after 2 seconds via the
  // auto-clear effect below. It is the sole positive signal a teacher gets that
  // their marks reached the database.
  //
  // NOTE: the status values the action returns use underscores ('no_live_class',
  // 'not_saving'), but saveState uses a hyphen ('not-saving').
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'not-saving'>('idle')
  // Bumped on every successful save, and read ONLY by the auto-clear effect's
  // dependency array - never rendered. A second consecutive 'saved' result would
  // otherwise call setSaveState with the value it already holds; React bails out,
  // the effect does not re-run, and the still-pending clear from the FIRST save
  // fires on its original deadline. The confirmation would then vanish mid-lesson
  // while writes are in fact still succeeding, which reads as "saving has
  // stopped". A distinct tick makes every success a real state change, so the
  // 2-second window restarts on each one.
  const [savedTick, setSavedTick] = useState(0)

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
            setSavedTick((n) => n + 1)
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

  // Auto-clear the "Saved" confirmation after 2 seconds.
  //
  // DISPLAY ONLY: this effect touches nothing but saveState. It never reads or
  // writes the annotations, the save chain or the debounce timer, so it cannot
  // affect persistence - the most it can do is show or hide a label. Its timeout
  // id is a plain local, deliberately NOT a ref and deliberately NOT timerRef,
  // which belongs to the autosave debounce and must not be shared.
  //
  // savedTick is in the deps so a REPEAT 'saved' restarts the window: without it
  // the second success sets saveState to the value it already holds, React bails
  // out, this effect never re-runs, and the badge would clear on the first save's
  // deadline instead of the latest one.
  //
  // The cleanup is also what protects the warning. If a later save resolves to
  // 'not-saving', this effect re-runs, the cleanup cancels the pending clear, and
  // the early return leaves the amber badge standing - so a stale timer can never
  // auto-dismiss a failure, only a confirmation.
  useEffect(() => {
    if (saveState !== 'saved') return
    const clearTimer = setTimeout(() => setSaveState('idle'), 2000)
    return () => clearTimeout(clearTimer)
  }, [saveState, savedTick])

  // Shared placement and shape for both badges, hoisted so the two can never
  // drift apart: each supplies only its own colours and text below. Declared
  // unconditionally (it is a plain object, not a hook) and mutually exclusive at
  // the call sites, since saveState holds exactly one value.
  const badgeBaseStyle: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    pointerEvents: 'none',
    borderRadius: 6,
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 600,
  }

  return (
    <div style={{ position: 'relative' }}>
      <PdfViewer
        fileUrl={fileUrl}
        initialAnnotations={initialAnnotations}
        onAnnotationsChange={handleAnnotationsChange}
      />
      {saveState === 'saved' && (
        <div
          style={{
            ...badgeBaseStyle,
            backgroundColor: '#ffffff',
            color: '#4b5563',
            border: '1px solid #E0DFDC',
          }}
        >
          Saved
        </div>
      )}
      {saveState === 'not-saving' && (
        <div
          style={{
            ...badgeBaseStyle,
            backgroundColor: '#FFFBEB',
            color: '#92400E',
            border: '1px solid #FDE68A',
          }}
        >
          Not saving — check your connection
        </div>
      )}
    </div>
  )
}
