'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer'
import { saveMaterialAnnotations } from '@/lib/materials/saveMaterialAnnotations'

// Trailing-debounce interval for annotation autosave. A burst of pen strokes
// collapses into one write this many ms after the student pauses. Same value as
// the teacher wrapper (AnnotatablePdf) - this is the same interaction.
const AUTOSAVE_DEBOUNCE_MS = 800

// ---------------------------------------------------------------------------
// Student homework layer over a page-scoped teaching-material grant.
//
// Follows the same autosave shape as src/components/pdf/AnnotatablePdf.tsx (the teacher's live-lesson
// wrapper) for everything about autosave, and adds the ONE thing the teacher
// path never needs: page-index translation.
//
// THE PAGE-INDEX DIVERGENCE (the locked contract, restated at every site it
// touches - see api/material-assignment-file/[assignmentId]/route.ts:206-213
// and migration 20260806100000 line 5):
//
//   /api/material-assignment-file REBUILDS the PDF, copying ONLY the granted
//   pages into a fresh document. So the document this viewer loads is a SLICE:
//     served page 0  ==  REAL document page (page_start - 1)
//
//   PdfViewer knows nothing about that. It mints and reports pageIndex values
//   as indices into the document it actually loaded - i.e. SERVED indices - and
//   exposes no offset prop (PdfViewer.tsx:147-165).
//
//   material_assignments.annotations stores REAL document page indices. So this
//   wrapper is the translation layer, and the only one:
//     seed  (stored -> viewer): pageIndex - offset
//     save  (viewer -> stored): pageIndex + offset
//
//   A whole-document grant (page_start/page_end both null) gives offset 0, which
//   makes both conversions the identity and this component behave exactly like
//   AnnotatablePdf. That is the case that would hide a broken implementation, so
//   nothing below special-cases it.
// ---------------------------------------------------------------------------

type Props = {
  assignmentId: string
  fileUrl: string
  // The stored homework layer, in REAL document page indices.
  initialAnnotations: Annotation[]
  // The grant's page range, exactly as stored. Both null = whole document.
  pageStart: number | null
  pageEnd: number | null
}

// Shift one annotation's page index, preserving every other field (and the
// union member) untouched. x/y/points are per-page 0..1 FRACTIONS
// (PdfViewer.tsx:196-205), so they are offset-free: pageIndex is the only field
// that ever needs translating.
function shiftPage(annotation: Annotation, delta: number): Annotation {
  return { ...annotation, pageIndex: annotation.pageIndex + delta }
}

// Split the stored layer into (a) what this served slice can actually render,
// converted to served indices, and (b) what it cannot.
//
// (b) is the fail-safe half. A stored index can fall outside the served window
// if the source PDF in the library was replaced, or if the row was written by
// anything other than this wrapper. Those marks CANNOT be shown - there is no
// page to put them on, and PdfViewer silently renders nothing for a pageIndex
// with no matching overlay (PdfViewer.tsx:3002-3015) - but they are still the
// student's work. They are held aside and merged back into every save payload,
// so a save can never be the thing that deletes them.
//
// A non-integer / non-numeric pageIndex (corrupt jsonb) fails the range test and
// is therefore held aside too: preserved, never rendered, never dropped.
function splitByServedRange(
  stored: Annotation[],
  offset: number,
  servedPageCount: number | null
): { seed: Annotation[]; held: Annotation[] } {
  const seed: Annotation[] = []
  const held: Annotation[] = []

  for (const annotation of stored) {
    const servedIndex = annotation.pageIndex - offset
    const inRange =
      Number.isInteger(servedIndex) &&
      servedIndex >= 0 &&
      (servedPageCount === null || servedIndex < servedPageCount)

    if (inRange) {
      seed.push(shiftPage(annotation, -offset))
    } else {
      held.push(annotation)
    }
  }

  return { seed, held }
}

// Append the held-aside marks to the converted payload, preserving their content
// and their REAL page indices verbatim.
//
// The one thing that is NOT preserved verbatim is a COLLIDING id. PdfViewer mints
// ids as `a<N>` from a counter it seeds off the ids it was given
// (PdfViewer.tsx:1128-1140) - and held-aside marks are, by definition, not in
// that seed. So a newly drawn mark can be minted with an id a held-aside mark
// already uses, and persisting both would put duplicate ids in the array: React
// key collisions, delete/recolour hitting two marks at once, and drag-move
// overwriting one with a copy of the other - exactly the failure that counter
// advance exists to prevent. A colliding held-aside mark is therefore re-idded
// into the `h<N>` namespace, which the viewer's `a<N>` minting can never reach.
// Its page, geometry, colour and text are untouched; only the internal id moves.
function mergeHeldAside(converted: Annotation[], held: Annotation[]): Annotation[] {
  if (held.length === 0) return converted

  const usedIds = new Set(converted.map((a) => a.id))
  let n = 0

  const safeHeld = held.map((annotation) => {
    if (!usedIds.has(annotation.id)) {
      usedIds.add(annotation.id)
      return annotation
    }
    do {
      n += 1
    } while (usedIds.has(`h${n}`))
    usedIds.add(`h${n}`)
    return { ...annotation, id: `h${n}` }
  })

  return [...converted, ...safeHeld]
}

export default function MaterialHomeworkPdf({
  assignmentId,
  fileUrl,
  initialAnnotations,
  pageStart,
  pageEnd,
}: Props) {
  // Served page 0 is REAL page (pageStart - 1). A whole-document grant has no
  // page_start, which is page 1, which is offset 0.
  const offset = (pageStart ?? 1) - 1

  // How many pages the file route will actually serve. It copies exactly
  // (page_end - page_start + 1) pages into the rebuilt document
  // (material-assignment-file/[assignmentId]/route.ts:215-223) and 422s rather
  // than serving anything wider, so the grant alone determines this - PdfViewer
  // exposes no page-count callback to read it back from. A whole-document grant
  // has no upper bound to check against (null), and none is needed: with offset
  // 0 the served index equals the real index.
  const servedPageCount =
    pageStart !== null && pageEnd !== null ? pageEnd - pageStart + 1 : null

  // Computed once per (row, grant) rather than per render: PdfViewer seeds from
  // this array when the DOCUMENT loads, and a fresh array identity on every
  // render would be pointless churn through its mirror ref
  // (PdfViewer.tsx:1103-1105).
  const { seed, held } = useMemo(
    () => splitByServedRange(initialAnnotations, offset, servedPageCount),
    [initialAnnotations, offset, servedPageCount]
  )

  // Held-aside marks live in a ref so the save callback always reads the current
  // set without taking them as a dependency (same mirroring pattern PdfViewer
  // uses for its own props).
  const heldAsideRef = useRef<Annotation[]>(held)
  useEffect(() => {
    heldAsideRef.current = held
  }, [held])

  // Debounce timer + the latest committed annotations pending a write, in SERVED
  // indices exactly as the viewer reported them.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<Annotation[] | null>(null)
  // Serialises saves for THIS grant: every flush chains off the previous one so
  // two updates to the same row are never in flight at once. Without this, a slow
  // earlier save and a newer save can race and reorder, letting the older/smaller
  // array commit last and silently drop the most recent marks - a fail-safe
  // violation. Chaining guarantees the last-issued save is the last to write. The
  // chained callback never rejects (it try/catches internally), so the chain can
  // never break.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  // Minimal fail-safe cue. Only an exact 'saved' clears it; a refused write, an
  // unexpected/absent status, or a transport error all show the warning, so marks
  // are never silently discarded on a real failure. There is no benign
  // "nothing to save" case here (unlike the teacher's 'no_live_class'): the grant
  // is the context, and while it is live every edit must persist.
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'not-saving'>('idle')

  // Persist the latest committed annotations onto the grant row.
  //
  // SAVE CONVERSION: the viewer reports SERVED indices; the row stores REAL
  // indices. Shift every mark back up by the offset, then append the held-aside
  // marks (already real, never shifted). This is the only place the payload is
  // built - saveMaterialAnnotations stores whatever it is handed, verbatim.
  const flush = useCallback(() => {
    const served = latestRef.current
    if (served === null) return
    latestRef.current = null

    const annotations = mergeHeldAside(
      served.map((a) => shiftPage(a, offset)),
      heldAsideRef.current
    )

    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const r = await saveMaterialAnnotations({ assignmentId, annotations })
        // Map each declared status explicitly. The warn-by-default branch means
        // any unknown/absent status is treated as not-saved (fail-safe), never
        // silently ignored. NOTE: the status values use underscores, but
        // saveState uses a hyphen.
        switch (r?.status) {
          case 'saved':
            setSaveState('saved')
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
  }, [assignmentId, offset])

  // Trailing debounce: reset the timer on every committed change so a burst of
  // pen strokes collapses into one write. PdfViewer only calls this for committed
  // changes, never for an in-progress draft and never for the seed - and if a
  // StrictMode double-mount ever did fire it for the seed, the write is a no-op
  // in content terms: seed + offset + held is byte-equivalent to the row already
  // stored.
  function handleAnnotationsChange(annotations: Annotation[]) {
    latestRef.current = annotations
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      flush()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  // On unmount (e.g. navigating away mid-edit), flush any pending write so the
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
      {/* No readOnly: the student edits their own homework layer while the grant
          is live. Revocation is enforced server-side - the file route stops
          serving the bytes and the save action stops matching a row. */}
      <PdfViewer
        fileUrl={fileUrl}
        initialAnnotations={seed}
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
