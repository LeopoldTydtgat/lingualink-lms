'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import { ZoomIn, ZoomOut, MoveHorizontal, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react'

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
  // Outer element that goes fullscreen.
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Scrollable body; we measure its inner width for fit-to-width and watch its
  // scroll position to keep the "Page X of Y" readout in sync.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Inner block that holds the stacked page canvases.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  // One entry per page, in page order, so Prev/Next can scroll the matching
  // canvas to the top. Rebuilt on every render pass; may be sparse mid-render.
  const canvasesRef = useRef<HTMLCanvasElement[]>([])
  // Page 1's intrinsic width at scale 1 (CSS px). The basis for fit-to-width.
  const firstPageWidthRef = useRef(0)
  // Throttles the scroll handler to one update per animation frame.
  const scrollRafRef = useRef<number | null>(null)
  // Bumped on every render pass so a stale async loop (e.g. from a fast double
  // zoom) detects it has been superseded and stops touching the DOM.
  const renderTokenRef = useRef(0)

  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [scale, setScale] = useState(1.2)
  // Fit-to-width mode: while on, the scale tracks the container width (and
  // re-tracks on resize). Any manual zoom releases it.
  const [fitMode, setFitMode] = useState(false)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Set the scale so page 1 exactly fills the available container width,
  // clamped to the zoom range. Reads only refs, so it is stable.
  const applyFitWidth = useCallback(() => {
    const container = containerRef.current
    const nativeWidth = firstPageWidthRef.current
    if (!container || nativeWidth <= 0) return
    const available = container.clientWidth
    if (available <= 0) return
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, available / nativeWidth))
    setScale(next)
  }, [])

  // Work out which page currently occupies the top half of the viewport and
  // surface it in the readout. setState bails out on an unchanged value.
  const updateCurrentPage = useCallback(() => {
    const scroller = scrollRef.current
    const canvases = canvasesRef.current
    if (!scroller || canvases.length === 0) return
    const scrollerTop = scroller.getBoundingClientRect().top
    const midline = scroller.clientHeight / 2
    let current = 1
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i]
      if (!canvas) continue
      const top = canvas.getBoundingClientRect().top - scrollerTop
      if (top < midline) current = i + 1
    }
    setCurrentPage(current)
  }, [])

  // Load the document (browser only) whenever the URL changes.
  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null

    setStatus('loading')
    setErrorMsg('')
    setNumPages(0)
    setCurrentPage(1)
    firstPageWidthRef.current = 0
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

        // Capture page 1's native width so fit-to-width has a basis the instant
        // the viewer is ready. A failure here is non-fatal: the render pass
        // below will surface any real document error.
        let firstWidth = 0
        try {
          const firstPage = await pdf.getPage(1)
          firstWidth = firstPage.getViewport({ scale: 1 }).width
        } catch {
          firstWidth = 0
        }
        if (cancelled) return

        firstPageWidthRef.current = firstWidth
        setNumPages(pdf.numPages)
        setCurrentPage(1)
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
  //
  // NOTE: this re-renders ALL pages on every zoom. That is acceptable while the
  // viewer is render-only; once annotation layers land it will need a render
  // queue / virtualization. Do not regress this into per-scroll re-rendering.
  useEffect(() => {
    if (status !== 'ready') return
    const pdf = pdfDocRef.current
    const container = containerRef.current
    if (!pdf || !container) return

    const token = ++renderTokenRef.current

    ;(async () => {
      try {
        container.replaceChildren()
        canvasesRef.current = []
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
          canvasesRef.current[pageNum - 1] = canvas

          await page.render({
            canvas,
            viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise
        }

        // Page heights have settled (and replaceChildren reset the scroll to the
        // top); refresh which page the readout reports.
        if (token === renderTokenRef.current) updateCurrentPage()
      } catch (err) {
        if (token !== renderTokenRef.current) return
        setErrorMsg(err instanceof Error ? err.message : 'Failed to render the PDF.')
        setStatus('error')
      }
    })()
  }, [status, scale, updateCurrentPage])

  // While fit-to-width is active, apply it now and keep it fitted as the window
  // (or fullscreen transition, which also fires resize) changes size. Debounced
  // so a resize drag does not re-render every page on every pixel.
  useEffect(() => {
    if (!fitMode || status !== 'ready') return
    applyFitWidth()
    let timer: ReturnType<typeof setTimeout> | null = null
    function onResize() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(applyFitWidth, 120)
    }
    window.addEventListener('resize', onResize)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', onResize)
    }
  }, [fitMode, status, applyFitWidth])

  // Keep the fullscreen label/icon correct even when the user exits via Esc.
  // (Same pattern as MaterialFileViewer.)
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // Cancel any pending scroll-tracking frame on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  function zoomOut() {
    setFitMode(false)
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 100) / 100))
  }
  function zoomIn() {
    setFitMode(false)
    setScale((s) => Math.min(MAX_SCALE, Math.round((s + SCALE_STEP) * 100) / 100))
  }

  function goToPage(target: number) {
    const clamped = Math.min(numPages, Math.max(1, target))
    const scroller = scrollRef.current
    const canvas = canvasesRef.current[clamped - 1]
    if (scroller && canvas) {
      // Scroll only this inner container (not the whole page) to the page top,
      // leaving a small gap above it.
      const top =
        canvas.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        12
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
    setCurrentPage(clamped)
  }

  function handleScroll() {
    if (scrollRafRef.current != null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      updateCurrentPage()
    })
  }

  function handleFullscreen() {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement === el) {
      if (typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => {})
    } else if (typeof el.requestFullscreen === 'function') {
      el.requestFullscreen().catch(() => {})
    }
  }

  const isReady = status === 'ready'
  const canZoomOut = isReady && scale > MIN_SCALE
  const canZoomIn = isReady && scale < MAX_SCALE
  const canPrev = isReady && currentPage > 1
  const canNext = isReady && currentPage < numPages
  const zoomPct = Math.round(scale * 100)

  const rootStyle: CSSProperties = {
    width: '100%',
    border: isFullscreen ? 'none' : '1px solid #e5e7eb',
    borderRadius: isFullscreen ? 0 : 12,
    overflow: 'hidden',
    backgroundColor: '#f9fafb',
    ...(isFullscreen ? { height: '100vh', display: 'flex', flexDirection: 'column' } : {}),
  }
  const bodyStyle: CSSProperties = {
    overflow: 'auto',
    padding: 16,
    ...(isFullscreen ? { flex: 1, minHeight: 0 } : { maxHeight: '80vh' }),
  }

  return (
    <div ref={rootRef} style={rootStyle}>
      {/* Toolbar: zoom, fit-to-width, page nav, fullscreen. No download, no
          print (the whole reason this viewer exists). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid #e5e7eb',
          backgroundColor: '#ffffff',
        }}
      >
        {/* Zoom */}
        <button
          type="button"
          onClick={zoomOut}
          disabled={!canZoomOut}
          aria-label="Zoom out"
          title="Zoom out"
          style={iconButtonStyle(canZoomOut)}
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
          title="Zoom in"
          style={iconButtonStyle(canZoomIn)}
        >
          <ZoomIn size={16} />
        </button>

        <span style={dividerStyle} aria-hidden />

        {/* Fit to width */}
        <button
          type="button"
          onClick={() => {
            setFitMode(true)
            applyFitWidth()
          }}
          disabled={!isReady}
          aria-pressed={fitMode}
          title="Fit page to width"
          style={toggleButtonStyle(fitMode, !isReady)}
        >
          <MoveHorizontal size={16} />
          Fit width
        </button>

        <span style={dividerStyle} aria-hidden />

        {/* Page navigation */}
        <button
          type="button"
          onClick={() => goToPage(currentPage - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
          title="Previous page"
          style={iconButtonStyle(canPrev)}
        >
          <ChevronLeft size={16} />
        </button>

        <span
          style={{
            minWidth: 96,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 600,
            color: '#374151',
            whiteSpace: 'nowrap',
          }}
        >
          Page {isReady ? currentPage : '-'} of {isReady ? numPages : '-'}
        </span>

        <button
          type="button"
          onClick={() => goToPage(currentPage + 1)}
          disabled={!canNext}
          aria-label="Next page"
          title="Next page"
          style={iconButtonStyle(canNext)}
        >
          <ChevronRight size={16} />
        </button>

        {/* Fullscreen, pushed to the right */}
        <button
          type="button"
          onClick={handleFullscreen}
          disabled={!isReady}
          title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
          style={{ ...toggleButtonStyle(true, !isReady), marginLeft: 'auto' }}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        </button>
      </div>

      {/* Body: stacked page canvases, scrollable. */}
      <div ref={scrollRef} onScroll={handleScroll} style={bodyStyle}>
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

// Square icon buttons (zoom, page nav). `active` means enabled here.
function iconButtonStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 34,
    height: 34,
    borderRadius: 8,
    border: `1px solid ${active ? ORANGE : '#e5e7eb'}`,
    backgroundColor: active ? '#fff7ed' : '#f9fafb',
    color: active ? ORANGE : '#9ca3af',
    cursor: active ? 'pointer' : 'not-allowed',
  }
}

// Labelled toggle buttons (fit-to-width, fullscreen). `active` => orange.
// `disabled` outranks `active` and shows the not-allowed state.
function toggleButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    height: 34,
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${disabled ? '#e5e7eb' : active ? ORANGE : '#d1d5db'}`,
    backgroundColor: disabled ? '#f9fafb' : active ? '#fff7ed' : '#ffffff',
    color: disabled ? '#9ca3af' : active ? ORANGE : '#4b5563',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }
}

const dividerStyle: CSSProperties = {
  width: 1,
  height: 22,
  flexShrink: 0,
  backgroundColor: '#e5e7eb',
}
