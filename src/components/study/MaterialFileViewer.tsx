'use client'

import { useState, useRef, useEffect } from 'react'
import { Maximize2, Minimize2, Trash2 } from 'lucide-react'
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer'
import AnnotatablePdf from '@/components/pdf/AnnotatablePdf'

// Shared file/preview viewer for study-sheet attachments, used by both the
// teacher detail page (annotatable mode, live-lesson autosave) and the student
// detail page (plain viewer). Extracted from the two duplicated inline copies.
//
// The two copies differed only in the PDF component (AnnotatablePdf vs
// PdfViewer) and per-card chrome; those differences are parameterised via props
// rather than forked. With no `onRemove`/annotation props supplied the student
// call renders byte-for-byte what its inline copy did.

type MaterialAttachment = { name: string; type: string }

type Props = {
  attachments: MaterialAttachment[]
  sheetId: string
  // 'annotatable' wraps each PDF in AnnotatablePdf (teacher live-lesson autosave);
  // 'plain' renders a read-only PdfViewer (student).
  mode: 'plain' | 'annotatable'
  // Only consumed in 'annotatable' mode — seed marks keyed by attachment name.
  annotationsByName?: Record<string, Annotation[]>
  wrapperClassName?: string
  cardClassName?: string
  cardStyle?: React.CSSProperties
  // When supplied (owned teacher sheets), each file header gains a remove button.
  // Absent -> no button rendered (student parity).
  onRemove?: (idx: number) => void
  removingName?: string | null
}

export default function MaterialFileViewer({
  attachments,
  sheetId,
  mode,
  annotationsByName,
  wrapperClassName = 'space-y-4',
  cardClassName = 'rounded-xl overflow-hidden bg-white shadow-sm',
  cardStyle = { border: '1px solid #f3f4f6' },
  onRemove,
  removingName,
}: Props) {
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
    <div className={wrapperClassName}>
      {attachments.map((att, idx) => {
        const isPdf = att.type === 'application/pdf'
        const isImage = att.type.startsWith('image/')
        // Same-origin proxy URL, served by the auth-gated /api/library-file route.
        const fileUrl = `/api/library-file/${sheetId}/${idx}`
        const isThisFullscreen = fullscreenIdx === idx
        const isRemoving = removingName === att.name

        const fullscreenButton = isImage ? (
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
        ) : null

        return (
          <div
            key={idx}
            ref={el => { containerRefs.current[idx] = el }}
            className={cardClassName}
            style={cardStyle}
          >
            <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-gray-500 truncate">{att.name}</span>
              {onRemove ? (
                <div className="flex items-center gap-2 flex-shrink-0">
                  {fullscreenButton}
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    disabled={isRemoving}
                    className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-50"
                    style={{ color: '#6b7280', border: '1px solid #E0DFDC', backgroundColor: '#ffffff' }}
                    title="Remove this file"
                  >
                    <Trash2 size={12} />
                    {isRemoving ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ) : (
                fullscreenButton
              )}
            </div>
            {isPdf ? (
              mode === 'annotatable' ? (
                // AnnotatablePdf wraps PdfViewer with live-lesson autosave: it renders
                // the PDF through the same proxy (its own toolbar, NO download/print)
                // and, during a live class, silently persists the teacher's marks.
                <AnnotatablePdf
                  fileUrl={fileUrl}
                  studySheetId={sheetId}
                  attachmentIndex={idx}
                  attachmentName={att.name}
                  initialAnnotations={annotationsByName?.[att.name]}
                />
              ) : (
                // PdfViewer replaces the native <iframe>: it renders the PDF through
                // the same proxy with its own toolbar and carries NO download/print.
                <PdfViewer fileUrl={fileUrl} />
              )
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
