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
  seedLessonId,
}: {
  fileUrl: string
  studySheetId: string
  attachmentIndex: number
  attachmentName: string
  initialAnnotations?: Annotation[]
  // The lesson initialAnnotations was seeded from (null: nothing live at load).
  // Read ONCE, at mount, into mountSeedLessonRef below — see the note there for
  // why a later value of this prop must never reach the guard. Required, not
  // optional, so a new mount cannot silently opt out of the guard.
  seedLessonId: string | null
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
  // Which lesson this tab's in-memory marks BELONG TO — the value sent as the
  // save-time equality guard. Two sources, in priority order:
  //  - savedLessonRef: the lesson the last SUCCESSFUL save wrote to (from the
  //    lessonId the action returns). Once a save has landed, that is definitively
  //    the class this array belongs to, whatever the page originally seeded.
  //  - mountSeedLessonRef: the seedLessonId captured at MOUNT, covering the window
  //    before any save has landed.
  //
  // BOTH ARE REFS, AND THAT IS THE POINT — do not "simplify" either back to the
  // live prop. PdfViewer re-seeds its annotations only when fileUrl changes
  // (its load effect is keyed on the url alone), and fileUrl is this attachment's
  // own path, so it never changes when the clock rolls into the next class. A
  // router.refresh() — the prep page fires one on every file upload/remove —
  // therefore pushes a FRESH seedLessonId down naming the NEW live class while the
  // viewer still holds the OLD class's marks. Reading the prop at save time would
  // re-arm the guard onto the new class and wave exactly the marks we are trying
  // to block straight through, with a "Saved" badge. Refs are immune to that churn.
  //
  // The BINDING is write-once — meaning the value actually sent as the guard,
  // savedLessonRef.current ?? mountSeedLessonRef.current, never moves to a different
  // lesson once it is non-null. Every arming site below therefore tests that combined
  // value (guardLessonId), not savedLessonRef alone: a tab seeded with lesson M has a
  // binding already, even though savedLessonRef is still null.
  //
  // savedLessonRef is armed by the first save attempt this tab makes from inside a class
  // — successful ('saved'), refused mid-class ('not_saving'), or refused because the
  // class is no longer writable ('no_live_class' carrying an attributionLessonId,
  // e.g. a class whose report is already filed). Arming on the refusals is what stops
  // a tab that marked up a whole post-report hour, or sat out a run of write
  // failures, from reaching the next class with a null guard and handing the entire
  // array over.
  //
  // Why never rebind: this tab's array only ever GROWS within a mount, so the class
  // it belongs to cannot change without a remount. A later attribution can name a
  // DIFFERENT class (draw during A, go stale at B, then draw again once B is reported
  // and A's grace has expired — attribution then names B while the array is still
  // A's). Rebinding there would point the guard at a class the marks do not belong
  // to; today nothing returns a reported lesson to 'scheduled' so no wrong write
  // follows, but that is an accident of other code, not a property of this one.
  //
  // Both refs null means this tab has never been inside a class, and the action lets
  // that through so the prep-then-class flow keeps saving.
  const savedLessonRef = useRef<string | null>(null)
  const mountSeedLessonRef = useRef<string | null>(seedLessonId)
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
  // 'stale' is the cross-lesson guard's state: the live class changed under a tab
  // left open, so this tab's marks belong to the previous class and the action
  // refused the write. Treat it as terminal — the badge says to reload, and (like
  // 'not-saving') it never auto-clears. It is not quite unrecoverable: recovery
  // happens only if the newer class is CANCELLED while the guard's own lesson is
  // still inside its 15-minute grace, since a reported newer class now suppresses
  // the grace candidate instead, so reporting does not reopen the previous lesson.
  // Rare, and it lands on the right class when it happens.
  //
  // NOTE: the status values the action returns use underscores ('no_live_class',
  // 'not_saving', 'stale_lesson'), but saveState uses a hyphen ('not-saving').
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'not-saving' | 'stale'>('idle')
  // Bumped on every successful save, and read ONLY by the auto-clear effect's
  // dependency array - never rendered. A second consecutive 'saved' result would
  // otherwise call setSaveState with the value it already holds; React bails out,
  // the effect does not re-run, and the still-pending clear from the FIRST save
  // fires on its original deadline. The confirmation would then vanish mid-lesson
  // while writes are in fact still succeeding, which reads as "saving has
  // stopped". A distinct tick makes every success a real state change, so the
  // 2-second window restarts on each one.
  const [savedTick, setSavedTick] = useState(0)

  // Persist the latest committed annotations to the live lesson, provided it is
  // still the lesson these marks belong to (the guard below).
  // saveLessonAnnotations resolves the target lesson itself (W2 — the lesson id we
  // send is an equality guard the server can only refuse on, never a destination)
  // and writes on the user-scoped client (W1). We consume the returned status to
  // drive the indicator, plus the lessonId to keep the guard current. Queued on
  // saveChainRef so saves for this attachment run strictly in order (see the ref's
  // note above).
  const flush = useCallback(() => {
    const annotations = latestRef.current
    if (annotations === null) return
    latestRef.current = null
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        // Where these marks actually live (see the two refs above), read at save
        // time so a save issued after an earlier one landed carries the newer,
        // stricter value.
        const guardLessonId = savedLessonRef.current ?? mountSeedLessonRef.current
        const r = await saveLessonAnnotations({ studySheetId, attachmentIndex, attachmentName, annotations, seedLessonId: guardLessonId })
        // Map each declared status explicitly. Only an exact 'saved' clears the
        // warning; 'no_live_class' is the benign common case (prep time / between
        // classes) and stays silent; 'not_saving' is a real refusal during a live
        // class. The warn-by-default branch means any unknown/absent status is
        // treated as not-saved (fail-safe), never silently ignored. NOTE: the
        // status values use underscores, but saveState uses a hyphen.
        //
        // The failing arms below also put `annotations` BACK on latestRef. flush
        // nulls it before issuing the save, so a save that then fails leaves those
        // strokes queued nowhere: if the teacher never draws again, the unmount
        // flush finds null and sends nothing. Restoring only makes the unmount
        // flush — and any later flush — carry these marks; it schedules no timer
        // and no retry of its own, and every later stroke resends the full array
        // anyway. It is conditional on latestRef.current still being null so an
        // array committed while the save was in flight is never clobbered. The
        // 'saved' and 'no_live_class' arms deliberately do NOT restore: one already
        // persisted, and prep marks are meant not to persist.
        switch (r?.status) {
          case 'saved':
            // Bind this tab's marks to the class they just landed in, but only if the
            // tab had no binding at all: a tab that opened during prep (seed null) and
            // then taught a class is no longer free to write into the NEXT one. When
            // guardLessonId was already set, r.lessonId provably equals it — the write
            // could not have succeeded otherwise — so skipping the assignment changes
            // nothing today, and keeps the invariant true here rather than borrowing it
            // from the server's equality check in another file.
            if (guardLessonId === null) savedLessonRef.current = r.lessonId
            setSaveState('saved')
            setSavedTick((n) => n + 1)
            break
          case 'no_live_class':
            // Nothing was written. But if the server could name the class this tab is
            // sitting in — one whose report is already filed, say, so it is no longer
            // writable — bind the marks to it. That is what stops a whole post-report
            // hour of marking from being waved into the NEXT class, and it is the only
            // way this tab learns a lesson id when no save can succeed. Both halves of
            // this condition are load-bearing: a null attributionLessonId (a genuine
            // gap between classes) must never CLEAR the binding, and a tab that already
            // has one must never be rebound to a newer class.
            //
            // The test is on guardLessonId, NOT on savedLessonRef: the binding that
            // matters is the one actually sent, which falls back to the mount seed. A
            // tab seeded with lesson M, still holding M's marks and with savedLessonRef
            // untouched, would otherwise be rebound to a later class N here — exactly
            // the rebind this rule exists to prevent.
            if (guardLessonId === null && r.attributionLessonId !== null) {
              savedLessonRef.current = r.attributionLessonId
            }
            // 'stale' is terminal (reload required); a later no-live-class result (the
            // stale class ending) must not clear it and imply things recovered.
            setSaveState((s) => (s === 'stale' ? s : 'idle'))
            break
          case 'not_saving':
            // The write was refused, but the guard PASSED to get this far, so the live
            // class is this tab's class. Bind to it so a sustained run of failures
            // during a class cannot leave the tab unbound and let the whole array into
            // the next one once the fault clears. Same guardLessonId test as the other
            // two arms, for the same reason.
            if (guardLessonId === null) savedLessonRef.current = r.lessonId
            if (latestRef.current === null) latestRef.current = annotations
            setSaveState('not-saving')
            break
          case 'stale_lesson':
            if (latestRef.current === null) latestRef.current = annotations
            setSaveState('stale')
            break
          default:
            if (latestRef.current === null) latestRef.current = annotations
            setSaveState('not-saving')
        }
      } catch {
        // A transport error is a harmless no-op for persistence, but for the
        // indicator it counts as not-saved (fail-safe): show the warning. Same
        // restore as the failing arms above — these strokes were unqueued when the
        // save was issued, so put them back for the unmount/next flush unless
        // something newer has already been committed.
        if (latestRef.current === null) latestRef.current = annotations
        setSaveState('not-saving')
      }
    })
    // seedLessonId is deliberately NOT a dependency: flush reads the guard from
    // the two refs above, never from the prop, so a new prop value must neither
    // rebuild this callback nor (via the unmount effect's [flush] deps) drain the
    // pending debounce early.
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
      {saveState === 'stale' && (
        <div
          style={{
            ...badgeBaseStyle,
            backgroundColor: '#FFFBEB',
            color: '#92400E',
            border: '1px solid #FDE68A',
          }}
        >
          Not saving - class changed, reload this page
        </div>
      )}
    </div>
  )
}
