'use client'

import { useMemo } from 'react'
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer'

// ---------------------------------------------------------------------------
// Teacher's read-only render of a student's material-homework layer.
//
// Deliberately NOT a reuse of the student's MaterialHomeworkPdf wrapper, and
// deliberately NOT a readOnly mode bolted onto it: that component exists to
// WRITE (debounced autosave, unmount flush, held-aside merge, save-status badge).
// This view must never write, and the strongest way to guarantee that is for the
// module to contain no write path at all - no server-action import, no
// onAnnotationsChange, no unmount flush. The database enforces the same thing
// from the other side (material_assignments has no teacher UPDATE policy); this
// is the code half of that guarantee.
//
// PAGE-INDEX TRANSLATION - the SEED half only:
//
//   /api/material-assignment-file REBUILDS the PDF, copying ONLY the granted
//   pages into a fresh document. The document this viewer loads is a SLICE:
//     served page 0  ==  REAL document page (page_start - 1)
//
//   PdfViewer knows nothing about that - it indexes into the document it actually
//   loaded (PdfViewer.tsx:147-165 exposes no offset prop), while
//   material_assignments.annotations stores REAL document page indices
//   (api/material-assignment-file/[assignmentId]/route.ts:206-213, migration
//   20260806100000 line 5). So every stored mark is shifted DOWN by the offset
//   before seeding. The student wrapper's opposite conversion (viewer -> stored)
//   has no counterpart here, because nothing here ever saves.
//
//   A whole-document grant (page_start / page_end both null) gives offset 0,
//   making the conversion the identity. That is the case that would hide a broken
//   implementation, so nothing below special-cases it.
// ---------------------------------------------------------------------------

type Props = {
  // Always /api/material-assignment-file/<assignmentId>. Passed to PdfViewer and
  // NEVER rendered as a visible link, iframe or embed: the native browser PDF
  // viewer offers save/print, which is exactly what this feature exists to avoid.
  fileUrl: string
  // The stored homework layer, in REAL document page indices.
  annotations: Annotation[]
  // The grant's page range, exactly as stored. Both null = whole document.
  pageStart: number | null
  pageEnd: number | null
  // The granted filename, shown as the card's caption.
  title: string
}

export default function MaterialHomeworkViewer({
  fileUrl,
  annotations,
  pageStart,
  pageEnd,
  title,
}: Props) {
  // Served page 0 is REAL page (pageStart - 1). A whole-document grant has no
  // page_start, which is page 1, which is offset 0.
  const offset = (pageStart ?? 1) - 1

  // How many pages the file route will actually serve: it copies exactly
  // (page_end - page_start + 1) pages into the rebuilt document and 422s rather
  // than serving anything wider, so the grant alone determines this. A
  // whole-document grant has no upper bound to check against (null), and needs
  // none: with offset 0 the served index equals the real index.
  const servedPageCount =
    pageStart !== null && pageEnd !== null ? pageEnd - pageStart + 1 : null

  // Computed once per (row, grant) rather than per render: PdfViewer seeds from
  // this array when the DOCUMENT loads, so a fresh array identity on every render
  // would be pointless churn through its mirror ref (PdfViewer.tsx:1103-1105).
  //
  // A mark whose stored index falls outside the served slice is DROPPED FROM THE
  // RENDER, never clamped onto a page it does not belong to - there is no page to
  // put it on. That happens if the library PDF was replaced after the grant was
  // written, or if the row was written by anything other than the student's
  // editor; a non-integer / non-numeric pageIndex (corrupt jsonb) fails the same
  // test. Dropping is display-only and lossless: this view never saves, so the
  // stored layer is untouched either way.
  const seed = useMemo(
    () =>
      annotations
        .map((a) => ({ ...a, pageIndex: a.pageIndex - offset }))
        .filter(
          (a) =>
            Number.isInteger(a.pageIndex) &&
            a.pageIndex >= 0 &&
            (servedPageCount === null || a.pageIndex < servedPageCount)
        ),
    [annotations, offset, servedPageCount]
  )

  const hiddenCount = annotations.length - seed.length

  return (
    <div
      className="bg-white rounded-xl shadow-sm overflow-hidden"
      style={{ border: '1px solid #f3f4f6' }}
    >
      <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
        <span className="text-xs font-semibold text-gray-500 truncate">{title}</span>
      </div>
      <div className="px-4 pt-3">
        <p className="text-xs" style={{ color: '#9ca3af' }}>
          The student&apos;s own notes on the pages you assigned. View only.
        </p>
        {hiddenCount > 0 && (
          <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>
            Some marks fall outside the assigned page range and are not shown.
          </p>
        )}
      </div>
      <div className="p-4">
        <PdfViewer fileUrl={fileUrl} initialAnnotations={seed} readOnly />
      </div>
    </div>
  )
}
