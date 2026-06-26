'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import { ZoomIn, ZoomOut } from 'lucide-react'

/*
 * Worker setup (Next.js 16 App Router + Vercel serverless):
 *
 * pdfjs-dist is imported DYNAMICALLY inside the browser-only effect, never at
 * module top level. That keeps the library out of the server bundle / SSR pass
 * (pdf.js has an optional Node "canvas" dependency that can break a server
 * build, and there is no DOM on the server anyway).
 *
 * The worker is wired with:
 *     new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)
 * which makes the bundler (Turbopack / Webpack) emit the worker as a hashed,
 * SAME-ORIGIN static asset and substitute its real runtime URL. This is the
 * approach that works on Vercel (no node_modules resolution at request time),
 * and it satisfies our CSP `worker-src 'self' blob:`. A bare module-specifier
 * string would not resolve on the client, and a CDN URL would be CSP-blocked.
 *
 * Fallback if a future bundler change ever fails to emit the asset: copy
 * node_modules/pdfjs-dist/build/pdf.worker.min.mjs into /public and set
 * workerSrc = '/pdf.worker.min.mjs' (must match the installed pdfjs-dist version).
 */

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const SCALE_STEP = 0.25
const ORANGE = '#FF8303'

interface Props {
  fileUrl: string
}

type Status = 'loading' | 'ready' | 'error'

export default function PdfViewer({ fileUrl }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  // Bumped on every render pass so a stale async loop (e.g. from a fast double
  // zoom) detects it has been superseded and stops touching the DOM.
  const renderTokenRef = useRef(0)

  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [scale, setScale] = useState(1.2)

  // Load the document (browser only) whenever the URL changes.
  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null

    setStatus('loading')
    setErrorMsg('')
    pdfDocRef.current = null

    ;(async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString()

        // withCredentials ensures the auth cookie reaches our (same-origin,
        // auth-gated) proxy; same-origin requests send cookies anyway, this is
        // just explicit.
        loadingTask = pdfjsLib.getDocument({ url: fileUrl, withCredentials: true })
        const pdf = await loadingTask.promise

        if (cancelled) {
          if (!loadingTask.destroyed) loadingTask.destroy()
          return
        }
        pdfDocRef.current = pdf
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load the PDF.')
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      pdfDocRef.current = null
      // Full teardown (aborts network + tears down the worker and document).
      // PDFDocumentProxy has no destroy() in v6; the loading task owns teardown.
      if (loadingTask && !loadingTask.destroyed) loadingTask.destroy()
    }
  }, [fileUrl])

  // Render every page to its own canvas, stacked vertically, whenever the
  // document becomes ready or the zoom changes.
  useEffect(() => {
    if (status !== 'ready') return
    const pdf = pdfDocRef.current
    const container = containerRef.current
    if (!pdf || !container) return

    const token = ++renderTokenRef.current

    ;(async () => {
      try {
        container.replaceChildren()
        // Render at device pixel ratio for crisp output on HiDPI screens.
        const outputScale = window.devicePixelRatio || 1

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (token !== renderTokenRef.current) return // superseded by a newer pass
          const page = await pdf.getPage(pageNum)
          const viewport = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width * outputScale)
          canvas.height = Math.floor(viewport.height * outputScale)
          canvas.style.width = `${Math.floor(viewport.width)}px`
          canvas.style.height = `${Math.floor(viewport.height)}px`
          canvas.style.display = 'block'
          canvas.style.margin = '0 auto 16px'
          canvas.style.backgroundColor = '#ffffff'
          canvas.style.borderRadius = '4px'
          canvas.style.boxShadow = '0 1px 6px rgba(0,0,0,0.15)'

          if (token !== renderTokenRef.current) return
          container.appendChild(canvas)

          await page.render({
            canvas,
            viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise
        }
      } catch (err) {
        if (token !== renderTokenRef.current) return
        setErrorMsg(err instanceof Error ? err.message : 'Failed to render the PDF.')
        setStatus('error')
      }
    })()
  }, [status, scale])

  function zoomOut() {
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 100) / 100))
  }
  function zoomIn() {
    setScale((s) => Math.min(MAX_SCALE, Math.round((s + SCALE_STEP) * 100) / 100))
  }

  const isReady = status === 'ready'
  const canZoomOut = isReady && scale > MIN_SCALE
  const canZoomIn = isReady && scale < MAX_SCALE
  const zoomPct = Math.round(scale * 100)

  return (
    <div
      style={{
        width: '100%',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#f9fafb',
      }}
    >
      {/* Toolbar: zoom only. No download, no print (by design for this milestone). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid #e5e7eb',
          backgroundColor: '#ffffff',
        }}
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={!canZoomOut}
          aria-label="Zoom out"
          style={zoomButtonStyle(canZoomOut)}
        >
          <ZoomOut size={16} />
        </button>

        <span style={{ minWidth: 52, textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#374151' }}>
          {zoomPct}%
        </span>

        <button
          type="button"
          onClick={zoomIn}
          disabled={!canZoomIn}
          aria-label="Zoom in"
          style={zoomButtonStyle(canZoomIn)}
        >
          <ZoomIn size={16} />
        </button>
      </div>

      {/* Body: stacked page canvases, scrollable. */}
      <div style={{ maxHeight: '80vh', overflow: 'auto', padding: 16 }}>
        {status === 'loading' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '60px 16px',
              color: '#6b7280',
              fontSize: 14,
            }}
          >
            <span
              className="animate-spin"
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: '2px solid #e5e7eb',
                borderTopColor: ORANGE,
                display: 'inline-block',
              }}
            />
            Loading PDF...
          </div>
        )}

        {status === 'error' && (
          <div style={{ padding: '40px 16px', textAlign: 'center' }}>
            <p style={{ fontWeight: 600, fontSize: 14, color: '#b91c1c', marginBottom: 4 }}>
              Could not display this PDF.
            </p>
            <p style={{ fontSize: 13, color: '#6b7280', wordBreak: 'break-word' }}>{errorMsg}</p>
          </div>
        )}

        {/* Always mounted so the ref is stable; shown only when ready. */}
        <div ref={containerRef} style={{ display: isReady ? 'block' : 'none' }} />
      </div>
    </div>
  )
}

// State-dependent colours via inline style (Tailwind v4 does not apply
// dynamically constructed colour classes).
function zoomButtonStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    borderRadius: 8,
    border: `1px solid ${active ? ORANGE : '#e5e7eb'}`,
    backgroundColor: active ? '#fff7ed' : '#f9fafb',
    color: active ? ORANGE : '#9ca3af',
    cursor: active ? 'pointer' : 'not-allowed',
  }
}
