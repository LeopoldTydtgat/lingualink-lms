'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import {
  ZoomIn,
  ZoomOut,
  MoveHorizontal,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  MousePointer2,
  Pencil,
  Highlighter,
  Type,
  Underline,
  ArrowUpRight,
  Star,
  Check,
  X,
  Undo2,
  Redo2,
  Trash2,
} from 'lucide-react'

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

// Pen stroke width and text size are stored in scale-1 ("page point") units and
// multiplied by the current scale at render time, so a mark keeps the same size
// relative to the page content at every zoom level.
const PEN_WIDTH = 2
// Highlighter and underline reuse the pen's stroke pipeline; only their committed
// width/opacity (and, for underline, geometry) differ. Widths are scale-1 px.
const HIGHLIGHTER_WIDTH = 14
const HIGHLIGHTER_OPACITY = 0.4
const UNDERLINE_WIDTH = 3
// Arrow is its own annotation type (not part of the stroke pipeline); this is
// its line width in scale-1 px (rendered width = ARROW_WIDTH * scale).
const ARROW_WIDTH = 3
const TEXT_SIZE = 16
// Editing/wrapping width for a text box, in scale-1 px (multiplied by scale).
const TEXT_BOX_WIDTH = 180
// Text-box font sizing (scale-1 units): the A- / A+ step and the clamp range.
const FONT_STEP = 4
const FONT_MIN = 8
const FONT_MAX = 48
// Shape-stamp sizing (scale-1 units): default box side, clamp range, and the
// A- / A+ step. Rendered side = size * scale, mirroring the text-box font sizing.
const STAMP_SIZE = 24
const STAMP_MIN = 12
const STAMP_MAX = 96
const STAMP_STEP = 6
// Maximum number of undo restore points kept (oldest dropped past this).
const HISTORY_LIMIT = 50

// Custom pen cursor: a lucide "pencil" rendered as an inline SVG data URI, with
// the hotspot at the pen tip (lower-left, "2 21"). A wider white outline sits
// behind the black pencil so the cursor stays visible over dark page areas.
// Falls back to crosshair where data-URI cursors are unsupported. ASCII only.
const PEN_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" stroke="#ffffff" stroke-width="4"/>' +
  '<path d="m15 5 4 4" stroke="#ffffff" stroke-width="4"/>' +
  '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" stroke="#000000" stroke-width="2"/>' +
  '<path d="m15 5 4 4" stroke="#000000" stroke-width="2"/>' +
  '</svg>'
const PEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PEN_CURSOR_SVG)}") 2 21, crosshair`

// Standard annotation palette (client-approved to go beyond the brand palette
// for this drawing feature). These are the eight standard annotation colours.
const COLOR_SWATCHES = [
  { value: '#000000', label: 'Black' },
  { value: '#E03131', label: 'Red' },
  { value: '#FF8303', label: 'Orange' },
  { value: '#F2C94C', label: 'Yellow' },
  { value: '#2F9E44', label: 'Green' },
  { value: '#1971C2', label: 'Blue' },
  { value: '#9C36B5', label: 'Purple' },
  { value: '#E64980', label: 'Pink' },
] as const
type AnnColor = (typeof COLOR_SWATCHES)[number]['value']

interface Props {
  fileUrl: string
  // -- Milestone 4 annotation wiring (all optional, additive) ----------------
  // When every prop below is omitted the viewer behaves EXACTLY as before:
  // empty annotation slate, full editing toolbar, no change callback. The two
  // current mount points pass none of these.
  //
  // Seed the annotation overlay when the document loads instead of starting
  // empty. Applied once per document (fileUrl) load -- never re-seeded on every
  // render (see the load effect).
  initialAnnotations?: Annotation[]
  // Read-only review mode: hides the annotation toolbar and pins the tool to
  // 'cursor' so no drawing input is possible (the overlay stays click-through).
  readOnly?: boolean
  // Called whenever the COMMITTED annotations array changes (finished stroke,
  // new/edited/moved/deleted text box, undo/redo/clear). Never fires for an
  // in-progress pen draft or for the initial seed.
  onAnnotationsChange?: (annotations: Annotation[]) => void
}

type Status = 'loading' | 'ready' | 'error'
type Tool = 'cursor' | 'pen' | 'text' | 'highlighter' | 'underline' | 'arrow' | 'stamp'

/*
 * ---------------------------------------------------------------------------
 * SERIALIZABLE ANNOTATION SHAPE (Milestone 4 will persist exactly this array).
 *
 * Every coordinate is a FRACTION of the page (0..1), per page, NEVER a raw
 * pixel. On render the fraction is multiplied by the current displayed canvas
 * size, so the same mark sits on the same spot at any zoom / fit / fullscreen.
 * The objects hold no DOM refs and no functions, so `annotations` is directly
 * JSON-serializable.
 * ---------------------------------------------------------------------------
 */
interface StrokeAnnotation {
  id: string
  type: 'stroke'
  pageIndex: number // 0-based
  color: AnnColor
  width: number // scale-1 px; rendered width = width * scale
  opacity?: number // 0..1; absent = 1 (fully opaque). Used by highlighter.
  points: { x: number; y: number }[] // each 0..1 fraction of the page
}
interface TextAnnotation {
  id: string
  type: 'text'
  pageIndex: number // 0-based
  color: AnnColor
  x: number // 0..1 fraction (top-left corner)
  y: number // 0..1 fraction (top-left corner)
  text: string
  fontSize: number // scale-1 px; rendered size = fontSize * scale
}
// A straight arrow with an arrowhead at `end`. A separate union member, NOT an
// overloaded StrokeAnnotation: it stores only its two endpoints (0..1 fractions),
// committed from the same pointer draft as the pen (first + last point kept).
interface ArrowAnnotation {
  id: string
  type: 'arrow'
  pageIndex: number // 0-based
  color: AnnColor
  width: number // scale-1 px; rendered width = width * scale
  start: { x: number; y: number } // 0..1 fraction
  end: { x: number; y: number } // 0..1 fraction
}
// A click-placed shape stamp (star / tick / cross). Not part of the stroke
// pipeline and NOT a drag gesture: it is placed by a single click at its centre
// and resized after placement by an A- / A+ control (see changeStampSize),
// mirroring the text box. It stores only its centre point and a box side length.
interface ShapeAnnotation {
  id: string
  type: 'shape'
  kind: 'star' | 'tick' | 'cross'
  pageIndex: number // 0-based
  color: AnnColor
  x: number // 0..1 fraction (centre of the stamp)
  y: number // 0..1 fraction (centre of the stamp)
  size: number // scale-1 px; rendered side = size * scale
}
export type Annotation = StrokeAnnotation | TextAnnotation | ArrowAnnotation | ShapeAnnotation

// Stable shared empty-annotations reference. Annotations are always REPLACED,
// never mutated in place, so one shared array is safe to reuse. A stable
// reference lets an empty seed compare equal (===) to the empty initial state,
// so the change effect can tell "nothing to seed" apart from a real user edit.
const EMPTY_ANNOTATIONS: Annotation[] = []

// Per-page geometry of the displayed canvas, relative to the overlay wrapper.
interface PageRect {
  left: number
  top: number
  width: number
  height: number
}
// In-progress freehand stroke (lives in state only until pointer-up commits it).
interface Draft {
  pageIndex: number
  points: { x: number; y: number }[]
}
// In-progress text-box drag (refs only; never rendered).
interface DragState {
  id: string
  startX: number
  startY: number
  originX: number
  originY: number
  width: number
  height: number
  moved: boolean
}
// A baked-in PDF link surfaced from the uploaded file's own annotations,
// normalised to the same 0..1 fraction-of-page model as every other overlay.
// `url` is already validated to a safe scheme.
interface PdfLink {
  pageIndex: number // 0-based
  left: number // 0..1 (top-left corner)
  top: number // 0..1 (top-left corner)
  width: number // 0..1
  height: number // 0..1
  url: string // absolute http / https / mailto only
}
// Minimal shape we read off pdf.js getAnnotations() results. Typed so member
// access is not `any` (keeps eslint clean); everything we touch is narrowed or
// validated before use.
interface RawLinkAnnotation {
  subtype?: string
  url?: unknown
  rect?: unknown
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
// Defence in depth on top of pdf.js: pdf.js already leaves `url` undefined for
// unsafe schemes (e.g. javascript:), but we additionally accept only absolute
// http / https / mailto URLs from the uploaded (untrusted) file. A relative URL
// has no scheme and throws in the URL constructor, so it is rejected too.
function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s === '') return null
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return null
  }
  const proto = parsed.protocol.toLowerCase()
  if (proto === 'http:' || proto === 'https:' || proto === 'mailto:') return parsed.href
  return null
}

// Fraction (0..1) of an element from a pointer's client coordinates.
function pointFraction(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return {
    x: r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0,
    y: r.height > 0 ? clamp01((clientY - r.top) / r.height) : 0,
  }
}

// Build a smoothed SVG path from 0..1 fraction points scaled to w x h pixels.
// Uses quadratic segments through the midpoints of consecutive points.
function strokePath(points: { x: number; y: number }[], w: number, h: number): string {
  if (points.length === 0) return ''
  const px = points.map((p) => ({ x: round1(p.x * w), y: round1(p.y * h) }))
  const first = px[0]
  if (!first) return ''
  if (px.length === 1) {
    // Single tap: a zero-length line so the round cap renders as a dot.
    return `M ${first.x} ${first.y} L ${first.x} ${first.y}`
  }
  let d = `M ${first.x} ${first.y}`
  for (let i = 1; i < px.length - 1; i++) {
    const cur = px[i]
    const nxt = px[i + 1]
    if (!cur || !nxt) continue
    const mx = round1((cur.x + nxt.x) / 2)
    const my = round1((cur.y + nxt.y) / 2)
    d += ` Q ${cur.x} ${cur.y} ${mx} ${my}`
  }
  const last = px[px.length - 1]
  if (last) d += ` L ${last.x} ${last.y}`
  return d
}

// Build a filled 5-point star path centred at (cx, cy) that fits a box of the
// given half-side (outer radius). Ten alternating outer/inner vertices starting
// at the top (-90 deg); inner radius is a fixed fraction so every star matches.
function starPath(cx: number, cy: number, outer: number): string {
  const inner = outer * 0.4
  let d = ''
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner
    const ang = -Math.PI / 2 + (i * Math.PI) / 5
    const x = round1(cx + r * Math.cos(ang))
    const y = round1(cy + r * Math.sin(ang))
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `
  }
  return `${d}Z`
}

// Pen, highlighter, underline and arrow all share ONE pointer flow: a draft
// that commits on pointer-up. Pen/highlighter/underline commit as a
// StrokeAnnotation (differing only in committed width/opacity/geometry); arrow
// keeps just the draft's first and last points and commits as an
// ArrowAnnotation. Grouping them keeps every "is this a drawing gesture?" check
// in one place (down seeds the draft, move extends it, up commits).
function isDrawingTool(t: Tool): boolean {
  return t === 'pen' || t === 'highlighter' || t === 'underline' || t === 'arrow'
}

// Editable text box: a focused, auto-growing textarea. Kept as its own
// component so the focus + auto-height effects have a stable home (the parent
// renders overlays from a plain map, which cannot host hooks).
function EditableTextBox({
  value,
  widthPx,
  fontSizePx,
  onChangeText,
  onCommit,
  style,
}: {
  value: string
  widthPx: number
  fontSizePx: number
  onChangeText: (v: string) => void
  onCommit: () => void
  style: CSSProperties
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // Focus on mount and drop the caret at the end of any existing text. The
  // focus() is DEFERRED to the next animation frame on purpose: a synchronous
  // focus() here loses a same-gesture focus race. The click that creates the
  // box settles after this effect runs and pulls focus straight back off the
  // textarea; its blur handler then fires, sees the box is empty, and discards
  // it via finishEditing -- all before a single frame paints, so nothing ever
  // appears. Running focus() on the next frame lets the creating gesture settle
  // first, so the box keeps focus and survives.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      const len = el.value.length
      try {
        el.setSelectionRange(len, len)
      } catch {
        // Some browsers throw on setSelectionRange for certain states; ignore.
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // Grow to fit content height whenever the text, width, or font size changes
  // (font size is included so A- / A+ resize the box live while editing).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, widthPx, fontSizePx])

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={(e) => onChangeText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCommit()
        }
      }}
      onBlur={onCommit}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ ...style, width: widthPx }}
    />
  )
}

export default function PdfViewer({ fileUrl, initialAnnotations, readOnly, onAnnotationsChange }: Props) {
  // Outer element that goes fullscreen.
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Scrollable body; we measure its inner width for fit-to-width and watch its
  // scroll position to keep the "Page X of Y" readout in sync.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Inner block that holds the stacked page canvases (populated imperatively).
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  // One entry per page, in page order, so Prev/Next can scroll the matching
  // canvas to the top and measurePages can place the overlays. Rebuilt on every
  // render pass; may be sparse mid-render.
  const canvasesRef = useRef<HTMLCanvasElement[]>([])
  // Page 1's intrinsic width at scale 1 (CSS px). The basis for fit-to-width.
  const firstPageWidthRef = useRef(0)
  // Throttles the scroll handler to one update per animation frame.
  const scrollRafRef = useRef<number | null>(null)

  // While a re-render (zoom / fit / fullscreen) rebuilds the canvases, the
  // browser can momentarily move the scroll position. This flag tells the scroll
  // handler to ignore those transient scrolls, so the page readout does not
  // flicker while the render effect restores the reader's page deterministically.
  const suppressScrollSyncRef = useRef(false)

  // True from the moment a render pass starts rebuilding the canvases until that
  // pass's completion (or error) path runs. A dedicated flag -- deliberately NOT
  // suppressScrollSyncRef, which the visibilitychange reassert also sets -- with
  // one meaning: the canvas DOM and scroll position are mid-rebuild and must not
  // be used as a capture source. A superseded pass never clears it; the newer
  // pass that superseded it re-armed it and owns clearing it.
  const rebuildInFlightRef = useRef(false)
  // The page the current/last render pass anchored to, captured from the live
  // DOM just before its rebuild. Persisted across passes so a pass that starts
  // while another is mid-flight (fast zoom) reuses this trustworthy anchor
  // instead of recapturing from the wiped/partial DOM, which would always read
  // ~page 1 and throw the reader to the start of the document.
  const anchorPageRef = useRef(1)

  // Page the reader was on when the tab was last hidden (e.g. they clicked a
  // baked-in link that opened a new tab). Captured on visibilitychange -> hidden
  // and restored on -> visible, because returning to the tab can nudge this
  // scroll container by about a page and nothing else re-asserts position (no
  // canvas rebuild fires for a plain tab switch).
  const lastVisiblePageRef = useRef(1)

  // Bumped on every render pass so a stale async loop (e.g. from a fast double
  // zoom) detects it has been superseded and stops touching the DOM.
  const renderTokenRef = useRef(0)
  // Monotonic id source for annotations (deterministic; avoids Date.now /
  // Math.random, which react-hooks/purity forbids and which would also make
  // ids non-reproducible).
  const idCounterRef = useRef(0)
  // Latest draft mirrored for synchronous reads in the pointer-up handler.
  const latestDraftRef = useRef<Draft | null>(null)
  // In-progress text-box drag.
  const dragRef = useRef<DragState | null>(null)
  // Pre-gesture annotation snapshot, captured at drag-start and pushed onto the
  // undo stack only if the drag actually moved the box (so a live drag's many
  // per-pixel updates collapse into one undo step). See onTextPointerUp.
  const pendingPastRef = useRef<Annotation[] | null>(null)
  // Always mirrors the latest annotations (kept in sync by an effect below) so
  // history snapshots read the true-current array, never a stale closure value.
  const annotationsRef = useRef<Annotation[]>([])
  // Latest initialAnnotations, mirrored so the document-load effect can seed
  // from the current prop WITHOUT taking initialAnnotations as a dependency
  // (which would re-run the whole load -- and wipe edits -- on every new array).
  // Synced by an effect declared just before the load effect.
  const initialAnnotationsRef = useRef<Annotation[] | undefined>(initialAnnotations)
  // Latest onAnnotationsChange, mirrored so the annotations-change effect always
  // calls the current callback and can depend only on the annotations array (a
  // new function identity from the parent never re-fires it on its own).
  const onAnnotationsChangeRef = useRef<((annotations: Annotation[]) => void) | undefined>(onAnnotationsChange)

  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [scale, setScale] = useState(1.2)
  // Fit-to-width mode: while on, the scale tracks the container width (and
  // re-tracks on resize). Any manual zoom releases it.
  const [fitMode, setFitMode] = useState(false)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // Editable page-number box. null when not being edited (the box then shows the
  // live current page); a string while the user is typing a page to jump to.
  const [pageDraft, setPageDraft] = useState<string | null>(null)

  const [isFullscreen, setIsFullscreen] = useState(false)

  // Annotation state. `annotations` IS the array that gets saved in Milestone 4.
  // Seeds from initialAnnotations at mount (falls back to the shared empty array
  // -- identical to the previous `useState([])` when the prop is absent). The
  // load effect re-seeds on every document (fileUrl) change.
  const [annotations, setAnnotations] = useState<Annotation[]>(() => initialAnnotations ?? EMPTY_ANNOTATIONS)
  // True while a SEED (the mount seed or a document-load re-seed) is being applied
  // to `annotations`, so the change effect can skip that seed instead of reporting
  // it as a user edit. Initialised true so the FIRST mount render (the seed / empty
  // initial state, never a user edit) is skipped; the load effect re-arms it only
  // when a re-seed actually changes the array; the change effect resets it on the
  // render that applies the seed. A flag, not a reference check: an undo/redo back
  // to the seed array still fires onAnnotationsChange.
  const isSeedingRef = useRef(true)
  const [tool, setTool] = useState<Tool>('cursor')
  // Which shape the stamp tool places. Held alongside `tool` (like the active
  // colour), so extending Tool with a single 'stamp' member keeps the union small
  // while the three toolbar buttons choose star / tick / cross.
  const [stampKind, setStampKind] = useState<'star' | 'tick' | 'cross'>('star')
  const [color, setColor] = useState<AnnColor>('#000000')
  const [draft, setDraft] = useState<Draft | null>(null)
  // A text box is either being EDITED (textarea) or SELECTED (outlined, with a
  // control bar) -- never both. These two ids are kept mutually exclusive by
  // enterEdit / selectBox below.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Displayed geometry of each page canvas, so overlays can be placed exactly
  // on top of their canvas at the current zoom.
  const [pageRects, setPageRects] = useState<PageRect[]>([])

  // Baked-in links surfaced from the uploaded PDF's own annotations. Fetched once
  // per document (links do not change with zoom); re-placed by measurePages like
  // every other overlay.
  const [pdfLinks, setPdfLinks] = useState<PdfLink[]>([])
  // Confirmation modal for "clear all" (replaces window.confirm so it also shows
  // in fullscreen, where only rootRef is visible).
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  // Undo / redo history as full-array snapshots. recordHistory() pushes the
  // pre-mutation array onto `past` and clears `future`; undo/redo shuttle
  // snapshots between the two stacks. `past` is capped at HISTORY_LIMIT.
  const [past, setPast] = useState<Annotation[][]>([])
  const [future, setFuture] = useState<Annotation[][]>([])

  function nextId(): string {
    idCounterRef.current += 1
    return `a${idCounterRef.current}`
  }

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

  // Measure every page canvas relative to the overlay wrapper. Canvas offsets
  // are taken against the wrapper (its offsetParent), so the absolutely placed
  // overlays line up with the centred, stacked canvases at any zoom. Reads only
  // refs, so it is stable.
  const measurePages = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const canvases = canvasesRef.current
    const rects: PageRect[] = []
    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i]
      if (!c) continue
      rects[i] = { left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight }
    }
    setPageRects(rects)
  }, [])

  // Capture the CURRENT annotations as an undo restore point and clear the redo
  // stack. Call this BEFORE each mutating action: at the call site the array has
  // not changed yet, so annotationsRef mirrors the before-state. Only ever
  // called from event handlers, never during render. useCallback so deleteBox
  // (below) and, through it, the Delete-key effect get a stable reference.
  const recordHistory = useCallback(() => {
    const snap = annotationsRef.current
    setPast((p) => (p.length >= HISTORY_LIMIT ? [...p.slice(1), snap] : [...p, snap]))
    setFuture([])
  }, [])

  // Delete one box and clear whichever id (if any) was pointing at it. Records
  // history first so the deletion is undoable. useCallback (depending only on
  // the stable recordHistory) so the Delete/Backspace key effect can list it as
  // a dependency without re-subscribing every render. The toolbar/control-bar x
  // and the Delete key all route through here, so every delete is undoable.
  const deleteBox = useCallback(
    (id: string) => {
      recordHistory()
      setAnnotations((anns) => anns.filter((a) => a.id !== id))
      setSelectedId((prev) => (prev === id ? null : prev))
      setEditingId((prev) => (prev === id ? null : prev))
    },
    [recordHistory],
  )

  // Keep initialAnnotationsRef current for the load effect below. Declared
  // BEFORE the load effect so that on a commit where fileUrl AND
  // initialAnnotations both change, this runs first and the load effect seeds
  // from the fresh value. Reading the prop via this ref (instead of listing it
  // as a load-effect dependency) avoids re-running the whole document load -- and
  // wiping in-progress edits -- when only the prop changes.
  useEffect(() => {
    initialAnnotationsRef.current = initialAnnotations
  }, [initialAnnotations])

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
    // A different document means a fresh history and a re-seeded annotation
    // slate: seed from the caller's saved overlay when provided, else empty
    // (exactly as before). Only the annotations seeding changed here; the
    // history/selection reset below is untouched. Mark seeding in progress so the
    // change effect skips this seed (a seed is not a user edit) -- but ONLY when
    // the seed differs from the current array. A reference-equal seed makes
    // setAnnotations bail (no re-render, so the change effect never runs to consume
    // the flag); arming it then would wrongly suppress the NEXT real edit.
    const seed = initialAnnotationsRef.current ?? EMPTY_ANNOTATIONS
    if (annotationsRef.current !== seed) isSeedingRef.current = true
    setAnnotations(seed)
    setEditingId(null)
    setSelectedId(null)
    setDraft(null)
    setPageRects([])
    setPdfLinks([])
    setPast([])
    setFuture([])
    pendingPastRef.current = null

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
  // viewer is render-only plus a light annotation overlay; once it carries many
  // strokes it will want a render queue / virtualization. Do not regress this
  // into per-scroll re-rendering. After the pass settles we re-measure the page
  // geometry so the annotation overlays re-place against the new canvas sizes.
  useEffect(() => {
    if (status !== 'ready') return
    const pdf = pdfDocRef.current
    const container = containerRef.current
    if (!pdf || !container) return

    const scroller = scrollRef.current

    // Remember which page is at the top of the viewport right now, so the same
    // page can be restored after the rebuild. Without this, a zoom / fit /
    // fullscreen rebuild lets the browser move the scroll position (it can jump
    // to the top, or via scroll anchoring to the last page). Reading the live
    // canvases + scroll BEFORE the rebuild captures the reader's true place.
    //
    // Capture from the live DOM ONLY when no other pass is mid-flight. An
    // in-flight pass has already wiped the canvases (replaceChildren below),
    // which collapses the scroll content and makes the browser clamp scrollTop
    // to 0 -- so a fresh capture here (a zoom click landing before the previous
    // pass finished) would always read ~page 1. Reuse the anchor the in-flight
    // pass captured from the intact DOM instead; scrolling is suppressed during
    // a rebuild, so the reader cannot have meaningfully moved since.
    let anchorPage = 1
    if (rebuildInFlightRef.current) {
      anchorPage = anchorPageRef.current
    } else if (scroller && canvasesRef.current.length > 0) {
      const scrollerTop = scroller.getBoundingClientRect().top
      const midline = scroller.clientHeight / 2
      for (let i = 0; i < canvasesRef.current.length; i++) {
        const c = canvasesRef.current[i]
        if (!c) continue
        const top = c.getBoundingClientRect().top - scrollerTop
        if (top < midline) anchorPage = i + 1
      }
    }
    // Persist the anchor so a pass that overlaps THIS one can reuse it. (In the
    // reuse branch above this writes back the value just read -- a no-op.)
    anchorPageRef.current = anchorPage

    const token = ++renderTokenRef.current
    // Ignore the transient scrolls the rebuild causes; we restore the page
    // ourselves below and re-enable the readout afterwards.
    suppressScrollSyncRef.current = true
    rebuildInFlightRef.current = true

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

        if (token === renderTokenRef.current) {
          // Restore the reader's page (instant, no smooth scroll) BEFORE syncing
          // the readout, so the page counter never flickers to the wrong page.
          const target = canvasesRef.current[anchorPage - 1]
          if (scroller && target) {
            const top =
              target.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top +
              scroller.scrollTop
            scroller.scrollTop = Math.max(0, top)
          }
          updateCurrentPage()
          measurePages()
          suppressScrollSyncRef.current = false
          rebuildInFlightRef.current = false
        }
      } catch (err) {
        if (token !== renderTokenRef.current) return
        suppressScrollSyncRef.current = false
        rebuildInFlightRef.current = false
        setErrorMsg(err instanceof Error ? err.message : 'Failed to render the PDF.')
        setStatus('error')
      }
    })()
  }, [status, scale, updateCurrentPage, measurePages])

  // Surface the links already baked into the uploaded PDF. Because we render to a
  // flat canvas, the native clickable links are lost; this re-derives them from
  // the file's annotation data so the overlay can render clickable hotspots. Runs
  // once per document, after it is ready. Internal page-jump links (dest, no url)
  // and unsafe schemes (url left undefined by pdf.js) are skipped.
  useEffect(() => {
    if (status !== 'ready') return
    const pdf = pdfDocRef.current
    if (!pdf) return
    let cancelled = false
    ;(async () => {
      const collected: PdfLink[] = []
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (cancelled) return
        try {
          const page = await pdf.getPage(pageNum)
          const annots = (await page.getAnnotations()) as RawLinkAnnotation[]
          const viewport = page.getViewport({ scale: 1 })
          const vw = viewport.width
          const vh = viewport.height
          if (vw <= 0 || vh <= 0) continue
          for (const a of annots) {
            if (a.subtype !== 'Link') continue
            const url = safeLinkUrl(a.url)
            if (!url) continue
            const rect = a.rect
            if (!Array.isArray(rect) || rect.length < 4) continue
            const conv = viewport.convertToViewportRectangle(rect as number[]) as number[]
            const cx0 = conv[0]
            const cy0 = conv[1]
            const cx1 = conv[2]
            const cy1 = conv[3]
            if (cx0 === undefined || cy0 === undefined || cx1 === undefined || cy1 === undefined) continue
            const x1 = Math.min(cx0, cx1)
            const x2 = Math.max(cx0, cx1)
            const y1 = Math.min(cy0, cy1)
            const y2 = Math.max(cy0, cy1)
            const left = clamp01(x1 / vw)
            const top = clamp01(y1 / vh)
            const width = clamp01((x2 - x1) / vw)
            const height = clamp01((y2 - y1) / vh)
            if (width <= 0 || height <= 0) continue
            collected.push({ pageIndex: pageNum - 1, left, top, width, height, url })
          }
        } catch {
          // A single page's links failing to parse is non-fatal; skip it.
        }
      }
      if (!cancelled) setPdfLinks(collected)
    })()
    return () => {
      cancelled = true
    }
  }, [status])

  // Re-measure overlay geometry on any container size change: window resize,
  // fullscreen transition, scrollbar appearance, and the margin:auto centring
  // shift that a width change causes. (Zoom is already handled by the render
  // pass above; this covers the size changes that do NOT re-render the pages.)
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measurePages())
    ro.observe(container)
    return () => ro.disconnect()
  }, [measurePages])

  // Keep the fullscreen label/icon correct even when the user exits via Esc.
  // (Same pattern as MaterialFileViewer.)
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // Hold the reader's page across a tab switch. Clicking a baked-in PDF link
  // opens a new tab; on returning, the browser can shift this scroll container by
  // about one page. The page-render effect's capture/restore does NOT cover this
  // (no zoom / fit / fullscreen, so no rebuild). So capture the page when the tab
  // is hidden and instantly restore it when it becomes visible again, suppressing
  // the transient scroll sync so the readout does not flicker. The restore is
  // deferred one frame so it runs AFTER the browser's own return adjustment.
  useEffect(() => {
    function onVisibilityChange() {
      const scroller = scrollRef.current
      const canvases = canvasesRef.current
      if (!scroller || canvases.length === 0) return

      if (document.visibilityState === 'hidden') {
        // Capture the page currently filling the top of the viewport.
        const scrollerTop = scroller.getBoundingClientRect().top
        const midline = scroller.clientHeight / 2
        let page = 1
        for (let i = 0; i < canvases.length; i++) {
          const c = canvases[i]
          if (!c) continue
          const top = c.getBoundingClientRect().top - scrollerTop
          if (top < midline) page = i + 1
        }
        lastVisiblePageRef.current = page
        return
      }

      // Became visible: re-assert the captured page over several animation frames.
      // The browser's own "scroll the focused element back into view" nudge can
      // land a frame or two after we become visible, so a single restore loses
      // the race. Re-applying for a handful of frames wins it. Scroll sync stays
      // suppressed for the whole window, then the readout is re-enabled.
      suppressScrollSyncRef.current = true
      let frames = 0
      const reassert = () => {
        const s = scrollRef.current
        const target = canvasesRef.current[lastVisiblePageRef.current - 1]
        if (s && target) {
          const top =
            target.getBoundingClientRect().top -
            s.getBoundingClientRect().top +
            s.scrollTop
          s.scrollTop = Math.max(0, top)
        }
        frames += 1
        if (frames < 6) {
          requestAnimationFrame(reassert)
        } else {
          updateCurrentPage()
          suppressScrollSyncRef.current = false
        }
      }
      requestAnimationFrame(reassert)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [updateCurrentPage])

  // Close the clear-confirmation modal on Escape. Only attached while the modal
  // is open, so it never competes with the text box's own Escape handler.
  useEffect(() => {
    if (!showClearConfirm) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowClearConfirm(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showClearConfirm])

  // Delete / Backspace removes the selected box. Attached ONLY while a box is
  // selected and NOT being edited, so it never competes with the textarea (where
  // Backspace must edit text). Routed through deleteBox so the key-delete is
  // recorded in history like every other delete.
  useEffect(() => {
    if (!selectedId || editingId) return
    const id = selectedId
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteBox(id)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedId, editingId, deleteBox])

  // Mirror the live draft so the pointer-up handler can read the full stroke
  // without a stale closure (and without nesting setState calls).
  useEffect(() => {
    latestDraftRef.current = draft
  }, [draft])

  // Mirror the latest annotations into a ref so history snapshots (recordHistory,
  // undo, redo) always read the true-current array, immune to stale closures.
  useEffect(() => {
    annotationsRef.current = annotations
  }, [annotations])

  // Keep onAnnotationsChangeRef pointing at the current callback.
  useEffect(() => {
    onAnnotationsChangeRef.current = onAnnotationsChange
  }, [onAnnotationsChange])

  // Report committed annotation changes to the caller. Keyed ONLY on the
  // annotations array, so it fires for every persisted change (finished stroke,
  // new/edited/moved/deleted text box, undo/redo/clear) but never for the
  // transient pen draft (separate state) and never for a document seed (a seed
  // sets isSeedingRef, which this effect consumes without firing). Because it is
  // an explicit flag and not a reference check, an undo/redo that returns the
  // array to the seed reference is still reported. No-op when no callback passed.
  useEffect(() => {
    if (isSeedingRef.current) {
      isSeedingRef.current = false
      return
    }
    onAnnotationsChangeRef.current?.(annotations)
  }, [annotations])

  // Read-only mode can never leave the cursor tool. On the first render the tool
  // already defaults to 'cursor', so a read-only viewer is inert from the start;
  // this also snaps back if readOnly is turned on at runtime while another tool
  // was active. Every overlay/pointer gate keys off `tool`, so pinning it to
  // 'cursor' makes the overlay click-through and text boxes non-interactive with
  // no other change. No-op (today's behaviour) when readOnly is falsy.
  useEffect(() => {
    if (readOnly) setTool('cursor')
  }, [readOnly])

  // Cancel any pending scroll-tracking frame on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  function zoomOut() {
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 100) / 100))
  }
  function zoomIn() {
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

  // Commit a typed page number from the page box: clamp to range and jump there.
  function commitPage(raw: string | null) {
    if (raw === null) return
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    goToPage(Math.min(numPages, Math.max(1, n)))
  }

  function handleScroll() {
    if (suppressScrollSyncRef.current) return
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

  // --- Annotation editing helpers -------------------------------------------

  function updateText(id: string, value: string) {
    setAnnotations((anns) =>
      anns.map((a) => (a.id === id && a.type === 'text' ? { ...a, text: value } : a)),
    )
  }

  // Leave editing `id`; drop the box entirely if it was left blank.
  function finishEditing(id: string) {
    setEditingId((prev) => (prev === id ? null : prev))
    setAnnotations((anns) => {
      const b = anns.find((a) => a.id === id)
      if (b && b.type === 'text' && b.text.trim() === '') return anns.filter((a) => a.id !== id)
      return anns
    })
  }

  // Enter edit mode on `id`. Records the pre-edit state first (one undo restores
  // it), commits any other open edit, then makes edit and selection mutually
  // exclusive (editing wins, selection cleared).
  function enterEdit(id: string) {
    recordHistory()
    if (editingId && editingId !== id) finishEditing(editingId)
    setSelectedId(null)
    setEditingId(id)
  }

  // Select `id` (the click / post-drag state). Commits any other open edit
  // first, then makes selection and editing mutually exclusive. Selection is not
  // an undoable action, so it does NOT record history.
  function selectBox(id: string) {
    if (editingId && editingId !== id) finishEditing(editingId)
    setEditingId(null)
    setSelectedId(id)
  }

  // A- / A+ : nudge one box's stored (scale-1) font size within the clamp range.
  // Rendered size is fontSize * scale, so this resizes the text live. One tap is
  // one undo step.
  function changeFontSize(id: string, delta: number) {
    recordHistory()
    setAnnotations((anns) =>
      anns.map((a) =>
        a.id === id && a.type === 'text'
          ? { ...a, fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, a.fontSize + delta)) }
          : a,
      ),
    )
  }

  // A- / A+ for a stamp: nudge one shape's stored (scale-1) box size within the
  // clamp range. Rendered side is size * scale, so this resizes the stamp live.
  // One tap is one undo step. Mirrors changeFontSize (size instead of fontSize).
  function changeStampSize(id: string, delta: number) {
    recordHistory()
    setAnnotations((anns) =>
      anns.map((a) =>
        a.id === id && a.type === 'shape'
          ? { ...a, size: Math.min(STAMP_MAX, Math.max(STAMP_MIN, a.size + delta)) }
          : a,
      ),
    )
  }

  function selectTool(t: Tool) {
    // Read-only mode never changes tool (belt-and-braces: the toolbar that calls
    // this is also hidden, and an effect pins the tool to 'cursor').
    if (readOnly) return
    if (editingId) finishEditing(editingId)
    // Switching tools drops any selection (the control bar is a Text-tool affordance).
    setSelectedId(null)
    // Clicking the active pen/text tool again toggles back to cursor; clicking
    // cursor (or a different tool) always selects that tool.
    setTool((prev) => (t !== 'cursor' && prev === t ? 'cursor' : t))
  }

  // Pick a stamp shape: activate the stamp tool AND set its kind. A separate
  // helper (not selectTool) because the stamp has a second dimension (kind): the
  // three buttons all map to tool 'stamp' but different kinds. Same readOnly and
  // edit/selection guards as selectTool. Clicking the ALREADY-active kind toggles
  // back to cursor (mirrors selectTool's active-tool toggle); switching to a
  // different kind stays on the stamp tool and just changes the kind.
  function selectStamp(kind: 'star' | 'tick' | 'cross') {
    if (readOnly) return
    if (editingId) finishEditing(editingId)
    setSelectedId(null)
    const sameActive = tool === 'stamp' && stampKind === kind
    setStampKind(kind)
    setTool(sameActive ? 'cursor' : 'stamp')
  }

  // Undo / redo: snapshot-based. Each restores a whole-array snapshot and clears
  // transient UI (a restored box comes back unselected, never mid-edit). State
  // is read from the closure outside the updaters; annotationsRef supplies the
  // current array to shuttle onto the opposite stack without nesting setStates.
  function undo() {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setFuture((f) => [annotationsRef.current, ...f])
    setPast((p) => p.slice(0, -1))
    setAnnotations(prev)
    setEditingId(null)
    setSelectedId(null)
    setDraft(null)
  }
  function redo() {
    if (future.length === 0) return
    const next = future[0]
    setPast((p) =>
      p.length >= HISTORY_LIMIT ? [...p.slice(1), annotationsRef.current] : [...p, annotationsRef.current],
    )
    setFuture((f) => f.slice(1))
    setAnnotations(next)
    setEditingId(null)
    setSelectedId(null)
    setDraft(null)
  }

  function clearAll() {
    recordHistory()
    setAnnotations([])
    setEditingId(null)
    setSelectedId(null)
    setDraft(null)
    setShowClearConfirm(false)
  }

  // --- Pointer handling on a page overlay -----------------------------------

  function onOverlayPointerDown(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (isDrawingTool(tool)) {
      const el = e.currentTarget
      if (typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Ignore: capture is a best-effort optimisation.
        }
      }
      const f = pointFraction(el, e.clientX, e.clientY)
      setDraft({ pageIndex, points: [f] })
    } else if (tool === 'text') {
      // Only the bare overlay handles empty-area clicks; clicks that bubbled up
      // from a text box or its control bar are handled there and stop
      // propagation, so they never reach here.
      if (e.target !== e.currentTarget) return
      // Empty-area click precedence:
      //   1. If a box is being edited, just commit it (do NOT also create one).
      //   2. Else if a box is selected, just clear the selection (click away).
      //   3. Else create a new box and go straight to editing it.
      if (editingId) {
        finishEditing(editingId)
        return
      }
      if (selectedId) {
        setSelectedId(null)
        return
      }
      const f = pointFraction(e.currentTarget, e.clientX, e.clientY)
      const id = nextId()
      setSelectedId(null)
      // Record before appending: one undo removes the whole box (typing into it
      // does not push, so the box and its text collapse into a single step).
      recordHistory()
      setAnnotations((anns) => [
        ...anns,
        { id, type: 'text', pageIndex, color, x: f.x, y: f.y, text: '', fontSize: TEXT_SIZE },
      ])
      setEditingId(id)
    } else if (tool === 'stamp') {
      // Click-to-place (never a drag): only the bare overlay creates a stamp.
      // Clicks that bubbled up from an existing stamp's hit target stop
      // propagation there, so they never reach here (same guard as text).
      if (e.target !== e.currentTarget) return
      // Precedence mirrors text: if something is selected, the first click just
      // clears the selection (click away to deselect) and places nothing; a
      // second click then places. Stamps have no editing state, so unlike text
      // there is no editing branch to commit first.
      if (selectedId) {
        setSelectedId(null)
        return
      }
      const f = pointFraction(e.currentTarget, e.clientX, e.clientY)
      const id = nextId()
      // Record before appending: one undo removes the whole stamp.
      recordHistory()
      setAnnotations((anns) => [
        ...anns,
        { id, type: 'shape', kind: stampKind, pageIndex, color, x: f.x, y: f.y, size: STAMP_SIZE },
      ])
      // Select (never edit) the new stamp so its A- / A+ control shows at once.
      setSelectedId(id)
    }
  }

  function onOverlayPointerMove(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (!isDrawingTool(tool)) return
    const f = pointFraction(e.currentTarget, e.clientX, e.clientY)
    setDraft((d) => (d && d.pageIndex === pageIndex ? { pageIndex, points: [...d.points, f] } : d))
  }

  function onOverlayPointerUp(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (!isDrawingTool(tool)) return
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    const d = latestDraftRef.current
    if (d && d.pageIndex === pageIndex && d.points.length > 0) {
      // Record before committing the stroke: one undo removes this stroke.
      recordHistory()
      if (tool === 'arrow') {
        // Arrow is NOT a stroke: keep only the draft's first and last points and
        // commit an ArrowAnnotation. start/end are always defined here (points is
        // non-empty), mirroring the underline start/end guard.
        const start = d.points[0]
        const end = d.points[d.points.length - 1]
        if (start && end) {
          const arrow: ArrowAnnotation = {
            id: nextId(),
            type: 'arrow',
            pageIndex,
            color,
            width: ARROW_WIDTH,
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
          }
          setAnnotations((anns) => [...anns, arrow])
        }
        setDraft(null)
        return
      }
      // Pen, highlighter and underline all commit as one StrokeAnnotation; only
      // the width/opacity (and, for underline, the geometry) differ. Pen is
      // unchanged: PEN_WIDTH and no opacity field.
      let width = PEN_WIDTH
      let opacity: number | undefined
      let points = d.points
      if (tool === 'highlighter') {
        width = HIGHLIGHTER_WIDTH
        opacity = HIGHLIGHTER_OPACITY
      } else if (tool === 'underline') {
        width = UNDERLINE_WIDTH
        const start = d.points[0]
        const end = d.points[d.points.length - 1]
        if (start && end) {
          // Force a straight horizontal rule: two points sharing the start's y,
          // spanning from the start x to the release x.
          points = [
            { x: start.x, y: start.y },
            { x: end.x, y: start.y },
          ]
        }
      }
      const stroke: StrokeAnnotation = {
        id: nextId(),
        type: 'stroke',
        pageIndex,
        color,
        width,
        ...(opacity !== undefined ? { opacity } : {}),
        points,
      }
      setAnnotations((anns) => [...anns, stroke])
    }
    setDraft(null)
  }

  // --- Pointer handling on a committed (non-editing) text box ---------------

  function onTextPointerDown(e: ReactPointerEvent<HTMLDivElement>, t: TextAnnotation, rect: PageRect) {
    if (tool !== 'text') return
    e.stopPropagation()
    const el = e.currentTarget
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    // Snapshot the pre-drag array now; onTextPointerUp pushes it only if an
    // actual move happened, so a plain select-click records nothing.
    pendingPastRef.current = annotationsRef.current
    dragRef.current = {
      id: t.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: t.x,
      originY: t.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
  }

  function onTextPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const dr = dragRef.current
    if (!dr) return
    e.stopPropagation()
    const dx = e.clientX - dr.startX
    const dy = e.clientY - dr.startY
    if (!dr.moved && Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true
    if (!dr.moved || dr.width <= 0 || dr.height <= 0) return
    const nx = clamp01(dr.originX + dx / dr.width)
    const ny = clamp01(dr.originY + dy / dr.height)
    setAnnotations((anns) => anns.map((a) => (a.id === dr.id && a.type === 'text' ? { ...a, x: nx, y: ny } : a)))
  }

  function onTextPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const dr = dragRef.current
    if (!dr) return
    e.stopPropagation()
    dragRef.current = null
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    // A real move pushes the pre-drag snapshot as one undo step; a no-move
    // select-click pushes nothing. Either way the pending snapshot is cleared.
    if (dr.moved) {
      const snap = pendingPastRef.current
      if (snap) {
        setPast((p) => (p.length >= HISTORY_LIMIT ? [...p.slice(1), snap] : [...p, snap]))
        setFuture([])
      }
    }
    pendingPastRef.current = null
    // A no-move click SELECTS the box; a finished drag also leaves it selected.
    // Double-click (a separate handler) is what enters edit mode.
    selectBox(dr.id)
  }

  // --- Pointer handling on a committed shape stamp --------------------------
  // Modelled on the text-box pointer flow (select + drag), kept as separate
  // handlers so the text path is unchanged. Differences: the target is a
  // ShapeAnnotation whose x/y is the stamp CENTRE, there is no editing state
  // (double-click does nothing), and the move predicate narrows to 'shape'.
  // Shapes reuse the same dragRef / pendingPastRef, the same 3px threshold, and
  // the same "snapshot only if actually moved" one-undo-step rule. Only one drag
  // runs at a time, so sharing dragRef with text is safe.
  function onShapePointerDown(e: ReactPointerEvent<HTMLDivElement>, s: ShapeAnnotation, rect: PageRect) {
    if (tool !== 'stamp') return
    e.stopPropagation()
    const el = e.currentTarget
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    pendingPastRef.current = annotationsRef.current
    dragRef.current = {
      id: s.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: s.x,
      originY: s.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
  }

  function onShapePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const dr = dragRef.current
    if (!dr) return
    e.stopPropagation()
    const dx = e.clientX - dr.startX
    const dy = e.clientY - dr.startY
    if (!dr.moved && Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true
    if (!dr.moved || dr.width <= 0 || dr.height <= 0) return
    const nx = clamp01(dr.originX + dx / dr.width)
    const ny = clamp01(dr.originY + dy / dr.height)
    setAnnotations((anns) => anns.map((a) => (a.id === dr.id && a.type === 'shape' ? { ...a, x: nx, y: ny } : a)))
  }

  function onShapePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const dr = dragRef.current
    if (!dr) return
    e.stopPropagation()
    dragRef.current = null
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    if (dr.moved) {
      const snap = pendingPastRef.current
      if (snap) {
        setPast((p) => (p.length >= HISTORY_LIMIT ? [...p.slice(1), snap] : [...p, snap]))
        setFuture([])
      }
    }
    pendingPastRef.current = null
    // A no-move click SELECTS the stamp; a finished drag also leaves it selected.
    selectBox(dr.id)
  }

  // --- Overlay rendering ----------------------------------------------------

  // Small resize + delete bar shown above (or, near the page top, below) a
  // selected or editing box. Buttons preventDefault on mouse/pointer down so
  // clicking them never steals focus from the textarea (which would blur ->
  // commit -> exit edit). The bar stops pointer propagation so clicking it never
  // reaches the overlay and deselects.
  function renderControlBar(t: TextAnnotation, below: boolean) {
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 0,
          ...(below ? { top: 'calc(100% + 4px)' } : { bottom: 'calc(100% + 4px)' }),
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 3,
          backgroundColor: '#ffffff',
          border: '1px solid #d1d5db',
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          pointerEvents: 'auto',
          whiteSpace: 'nowrap',
          lineHeight: 1,
        }}
      >
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => changeFontSize(t.id, -FONT_STEP)}
          aria-label="Decrease text size"
          title="Decrease text size"
          style={controlButtonStyle('#4b5563')}
        >
          A-
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => changeFontSize(t.id, FONT_STEP)}
          aria-label="Increase text size"
          title="Increase text size"
          style={controlButtonStyle('#4b5563')}
        >
          A+
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => deleteBox(t.id)}
          aria-label="Delete text box"
          title="Delete text box"
          style={controlButtonStyle('#FD5602')}
        >
          x
        </button>
      </div>
    )
  }

  // Resize + delete bar for a selected STAMP. Identical structure and styling to
  // renderControlBar, but A- / A+ drive changeStampSize (box size) instead of
  // changeFontSize. Kept separate so the text control bar is untouched. Buttons
  // preventDefault on pointer/mouse down and the bar stops propagation, exactly
  // like the text bar, so clicking it never deselects the stamp.
  function renderShapeControlBar(s: ShapeAnnotation, below: boolean) {
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 0,
          ...(below ? { top: 'calc(100% + 4px)' } : { bottom: 'calc(100% + 4px)' }),
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 3,
          backgroundColor: '#ffffff',
          border: '1px solid #d1d5db',
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          pointerEvents: 'auto',
          whiteSpace: 'nowrap',
          lineHeight: 1,
        }}
      >
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => changeStampSize(s.id, -STAMP_STEP)}
          aria-label="Decrease stamp size"
          title="Decrease stamp size"
          style={controlButtonStyle('#4b5563')}
        >
          A-
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => changeStampSize(s.id, STAMP_STEP)}
          aria-label="Increase stamp size"
          title="Increase stamp size"
          style={controlButtonStyle('#4b5563')}
        >
          A+
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => deleteBox(s.id)}
          aria-label="Delete stamp"
          title="Delete stamp"
          style={controlButtonStyle('#FD5602')}
        >
          x
        </button>
      </div>
    )
  }

  function renderTextBox(t: TextAnnotation, rect: PageRect) {
    const isEditing = t.id === editingId
    const isSelected = t.id === selectedId
    const interactive = tool === 'text'
    // Font / colour shared by both the textarea and the static text.
    const baseStyle: CSSProperties = {
      color: t.color,
      fontFamily: 'inherit',
      fontWeight: 600,
      fontSize: t.fontSize * scale,
      lineHeight: 1.25,
    }
    // Anchor the control bar above the box by default; flip below when the box
    // sits too near the page top for the bar to fit above it.
    const below = t.y * rect.height < 40
    const bar = isEditing || isSelected ? renderControlBar(t, below) : null

    // Wrapper pinned at the box's 0..1 top-left. It hugs the box (lineHeight 0
    // kills the inline-block descender gap) so the control bar, anchored to the
    // wrapper edges, sits flush above/below the box's real size and scrolls /
    // zooms with it. pointerEvents none so only the box / bar inside react.
    const wrapperStyle: CSSProperties = {
      position: 'absolute',
      left: `${t.x * 100}%`,
      top: `${t.y * 100}%`,
      lineHeight: 0,
      pointerEvents: 'none',
    }

    if (isEditing) {
      return (
        <div key={t.id} style={wrapperStyle}>
          <EditableTextBox
            value={t.text}
            widthPx={TEXT_BOX_WIDTH * scale}
            fontSizePx={t.fontSize * scale}
            onChangeText={(v) => updateText(t.id, v)}
            onCommit={() => finishEditing(t.id)}
            style={{
              ...baseStyle,
              position: 'relative',
              display: 'block',
              padding: `${2 * scale}px ${4 * scale}px`,
              background: 'rgba(255,255,255,0.9)',
              border: `1px solid ${ORANGE}`,
              borderRadius: 4,
              resize: 'none',
              overflow: 'hidden',
              outline: 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              boxSizing: 'border-box',
              pointerEvents: 'auto',
            }}
          />
          {bar}
        </div>
      )
    }

    return (
      <div key={t.id} style={wrapperStyle}>
        <div
          onPointerDown={(e) => onTextPointerDown(e, t, rect)}
          onPointerMove={onTextPointerMove}
          onPointerUp={onTextPointerUp}
          onDoubleClick={() => enterEdit(t.id)}
          style={{
            ...baseStyle,
            display: 'inline-block',
            verticalAlign: 'top',
            maxWidth: TEXT_BOX_WIDTH * scale,
            padding: `${2 * scale}px ${4 * scale}px`,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'none',
            pointerEvents: interactive ? 'auto' : 'none',
            cursor: interactive ? 'move' : 'default',
            // Selected => thin orange outline (outline, not border, so the
            // unselected box renders at exactly the same size / position).
            outline: isSelected ? `1px solid ${ORANGE}` : 'none',
            outlineOffset: isSelected ? 1 : 0,
            textShadow: '0 1px 2px rgba(255,255,255,0.7)',
          }}
        >
          {t.text === '' ? ' ' : t.text}
        </div>
        {bar}
      </div>
    )
  }

  // Transparent pointer hit target for a committed stamp. The visible glyph is
  // drawn in the page <svg> (which is pointerEvents:none), so — exactly like a
  // text box — the stamp needs a real DOM element to receive select/drag. This
  // div is centred on the stamp (translate -50% so x/y is the CENTRE) and sized
  // to the stamp's box. It is interactive ONLY under the stamp tool (mirrors the
  // text box's `interactive = tool === 'text'` gate): under cursor the overlay is
  // click-through, under other tools this stays pointerEvents:none. When the
  // stamp is selected it also hosts the A- / A+ / delete control bar.
  function renderShapeHitTarget(s: ShapeAnnotation, rect: PageRect) {
    const interactive = tool === 'stamp'
    const isSelected = s.id === selectedId
    const sidePx = s.size * scale
    // Flip the control bar below the stamp when its top edge sits too near the
    // page top for the bar to fit above (mirrors the text box's `below`).
    const below = s.y * rect.height - sidePx / 2 < 40
    return (
      <div
        key={`shape-hit-${s.id}`}
        onPointerDown={(e) => onShapePointerDown(e, s, rect)}
        onPointerMove={onShapePointerMove}
        onPointerUp={onShapePointerUp}
        style={{
          position: 'absolute',
          left: `${s.x * 100}%`,
          top: `${s.y * 100}%`,
          width: sidePx,
          height: sidePx,
          transform: 'translate(-50%, -50%)',
          pointerEvents: interactive ? 'auto' : 'none',
          cursor: interactive ? 'move' : 'default',
          touchAction: interactive ? 'none' : 'auto',
        }}
      >
        {isSelected ? renderShapeControlBar(s, below) : null}
      </div>
    )
  }

  function renderPageOverlay(rect: PageRect, pageIndex: number) {
    const pageStrokes = annotations.filter(
      (a): a is StrokeAnnotation => a.type === 'stroke' && a.pageIndex === pageIndex,
    )
    const pageTexts = annotations.filter(
      (a): a is TextAnnotation => a.type === 'text' && a.pageIndex === pageIndex,
    )
    const pageArrows = annotations.filter(
      (a): a is ArrowAnnotation => a.type === 'arrow' && a.pageIndex === pageIndex,
    )
    const pageShapes = annotations.filter(
      (a): a is ShapeAnnotation => a.type === 'shape' && a.pageIndex === pageIndex,
    )
    const drawingHere = draft && draft.pageIndex === pageIndex
    // Live arrow-draft endpoints (draft's first point -> current point), computed
    // here so the SVG stays flat. With noUncheckedIndexedAccess a draft point can
    // be undefined, so the render checks both before drawing.
    const draftArrowStart = drawingHere && draft && tool === 'arrow' ? draft.points[0] : undefined
    const draftArrowEnd =
      drawingHere && draft && tool === 'arrow' ? draft.points[draft.points.length - 1] : undefined

    const pageLinks = pdfLinks.filter((l) => l.pageIndex === pageIndex)

    return (
      <div
        key={pageIndex}
        onPointerDown={(e) => onOverlayPointerDown(e, pageIndex)}
        onPointerMove={(e) => onOverlayPointerMove(e, pageIndex)}
        onPointerUp={(e) => onOverlayPointerUp(e, pageIndex)}
        style={{
          position: 'absolute',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          // Click-through in cursor mode so scroll / zoom work normally.
          pointerEvents: tool === 'cursor' ? 'none' : 'auto',
          cursor: isDrawingTool(tool) ? PEN_CURSOR : tool === 'text' ? 'text' : 'default',
          touchAction: tool === 'cursor' ? 'auto' : 'none',
          userSelect: 'none',
        }}
      >
        {pageLinks.map((lk, i) => (
          <a
            key={`pdflink-${pageIndex}-${i}`}
            href={lk.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              // Drop focus from the link right after the new tab is opened. A
              // focused link causes the browser to scroll it back into view when
              // the user returns to this tab, which shifts the page by about one.
              // Blurring removes that cause; the visibilitychange handler is the
              // safety net. Deferred so the navigation (open in new tab) is not
              // disturbed.
              const a = e.currentTarget
              requestAnimationFrame(() => a.blur())
            }}
            title={lk.url}
            style={{
              position: 'absolute',
              left: lk.left * rect.width,
              top: lk.top * rect.height,
              width: lk.width * rect.width,
              height: lk.height * rect.height,
              display: 'block',
              borderRadius: 2,
              // Transparent by default (the link text is already styled in the
              // PDF; the pointer cursor is the affordance). To make hotspots
              // faintly visible instead, change to: 'rgba(25, 113, 194, 0.10)'.
              backgroundColor: 'transparent',
              cursor: 'pointer',
              // Clickable only in cursor mode; inert under pen/text so a link can
              // never steal a stroke or a text placement (the parent overlay then
              // catches the gesture). Mirrors the text-box interactivity gate.
              pointerEvents: tool === 'cursor' ? 'auto' : 'none',
            }}
          />
        ))}
        <svg
          width={rect.width}
          height={rect.height}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
        >
          {/* Arrowhead markers: one per committed arrow (fill baked to that
              arrow's colour, so a per-arrow id avoids colour bleed) plus one for
              the live draft. markerUnits defaults to strokeWidth, so each head
              scales with its line's width at every zoom. */}
          <defs>
            {pageArrows.map((a) => (
              <marker
                key={`arrowhead-${a.id}`}
                id={`arrowhead-${a.id}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={a.color} />
              </marker>
            ))}
            {drawingHere && draft && tool === 'arrow' ? (
              <marker
                id="arrowhead-draft"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
              </marker>
            ) : null}
          </defs>
          {pageStrokes.map((s) => (
            <path
              key={s.id}
              d={strokePath(s.points, rect.width, rect.height)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width * scale}
              strokeOpacity={s.opacity ?? 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {pageArrows.map((a) => (
            <line
              key={a.id}
              x1={a.start.x * rect.width}
              y1={a.start.y * rect.height}
              x2={a.end.x * rect.width}
              y2={a.end.y * rect.height}
              stroke={a.color}
              strokeWidth={a.width * scale}
              strokeLinecap="round"
              markerEnd={`url(#arrowhead-${a.id})`}
            />
          ))}
          {pageShapes.map((s) => {
            // Centre + box side in display px. x/y is the stamp CENTRE.
            const cx = s.x * rect.width
            const cy = s.y * rect.height
            const side = s.size * scale
            const half = side / 2
            // Tick / cross are stroked; width scales with the stamp (min 2px so a
            // tiny stamp stays visible). Star is filled with the stamp colour.
            const strokeW = Math.max(2, side * 0.12)
            const isSelected = s.id === selectedId
            return (
              <g key={s.id}>
                {isSelected ? (
                  // Selection frame in the orange accent, just outside the box
                  // (like the text box's outline; does not resize the stamp).
                  <rect
                    x={round1(cx - half - 3)}
                    y={round1(cy - half - 3)}
                    width={round1(side + 6)}
                    height={round1(side + 6)}
                    rx={3}
                    fill="none"
                    stroke={ORANGE}
                    strokeWidth={1}
                  />
                ) : null}
                {s.kind === 'star' ? (
                  <path d={starPath(cx, cy, half)} fill={s.color} stroke="none" />
                ) : s.kind === 'tick' ? (
                  <path
                    d={`M ${round1(cx - half * 0.6)} ${round1(cy + half * 0.05)} L ${round1(cx - half * 0.15)} ${round1(cy + half * 0.55)} L ${round1(cx + half * 0.7)} ${round1(cy - half * 0.55)}`}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={strokeW}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <>
                    <line
                      x1={round1(cx - half * 0.6)}
                      y1={round1(cy - half * 0.6)}
                      x2={round1(cx + half * 0.6)}
                      y2={round1(cy + half * 0.6)}
                      stroke={s.color}
                      strokeWidth={strokeW}
                      strokeLinecap="round"
                    />
                    <line
                      x1={round1(cx + half * 0.6)}
                      y1={round1(cy - half * 0.6)}
                      x2={round1(cx - half * 0.6)}
                      y2={round1(cy + half * 0.6)}
                      stroke={s.color}
                      strokeWidth={strokeW}
                      strokeLinecap="round"
                    />
                  </>
                )}
              </g>
            )
          })}
          {drawingHere && draft && tool !== 'arrow' ? (
            <path
              d={strokePath(draft.points, rect.width, rect.height)}
              fill="none"
              stroke={color}
              strokeWidth={PEN_WIDTH * scale}
              strokeOpacity={tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {drawingHere && draft && tool === 'arrow' && draftArrowStart && draftArrowEnd ? (
            <line
              x1={draftArrowStart.x * rect.width}
              y1={draftArrowStart.y * rect.height}
              x2={draftArrowEnd.x * rect.width}
              y2={draftArrowEnd.y * rect.height}
              stroke={color}
              strokeWidth={ARROW_WIDTH * scale}
              strokeLinecap="round"
              markerEnd="url(#arrowhead-draft)"
            />
          ) : null}
        </svg>
        {pageTexts.map((t) => renderTextBox(t, rect))}
        {pageShapes.map((s) => renderShapeHitTarget(s, rect))}
      </div>
    )
  }

  const isReady = status === 'ready'
  const canZoomOut = isReady && scale > MIN_SCALE
  const canZoomIn = isReady && scale < MAX_SCALE
  const canPrev = isReady && currentPage > 1
  const canNext = isReady && currentPage < numPages
  const canUndo = isReady && past.length > 0
  const canRedo = isReady && future.length > 0
  const canClear = isReady && annotations.length > 0
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
    // Disable browser scroll anchoring: when the page canvases are rebuilt on
    // zoom / fit / fullscreen, anchoring would otherwise move the scroll position
    // (often to the last page). We restore the reader's page ourselves.
    overflowAnchor: 'none',
    padding: 16,
    ...(isFullscreen ? { flex: 1, minHeight: 0 } : { maxHeight: '80vh' }),
  }

  return (
    <div ref={rootRef} style={rootStyle}>
      {/* Toolbar: zoom, fit-to-width, page nav, annotation tools, fullscreen.
          No download, no print (the whole reason this viewer exists). */}
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
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: '#374151',
            whiteSpace: 'nowrap',
          }}
        >
          Page
          <input
            type="text"
            inputMode="numeric"
            aria-label="Page number"
            title="Type a page number and press Enter"
            disabled={!isReady}
            value={pageDraft ?? (isReady ? String(currentPage) : '-')}
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => {
              setPageDraft(String(currentPage))
              e.currentTarget.select()
            }}
            onBlur={() => {
              commitPage(pageDraft)
              setPageDraft(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitPage(pageDraft)
                setPageDraft(null)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setPageDraft(null)
                e.currentTarget.blur()
              }
            }}
            style={pageInputStyle(isReady)}
          />
          of {isReady ? numPages : '-'}
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

        {/* Annotation, colour and undo/redo/clear controls are hidden entirely
            in read-only mode; zoom, fit, page nav and fullscreen stay visible. */}
        {!readOnly && (
          <>
        <span style={dividerStyle} aria-hidden />

        {/* Annotation tools */}
        <button
          type="button"
          onClick={() => selectTool('cursor')}
          disabled={!isReady}
          aria-pressed={tool === 'cursor'}
          aria-label="Select / scroll"
          title="Select / scroll"
          style={toolButtonStyle(tool === 'cursor', !isReady)}
        >
          <MousePointer2 size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectTool('pen')}
          disabled={!isReady}
          aria-pressed={tool === 'pen'}
          aria-label="Pen"
          title="Pen (draw)"
          style={toolButtonStyle(tool === 'pen', !isReady)}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectTool('highlighter')}
          disabled={!isReady}
          aria-pressed={tool === 'highlighter'}
          aria-label="Highlighter"
          title="Highlighter"
          style={toolButtonStyle(tool === 'highlighter', !isReady)}
        >
          <Highlighter size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectTool('underline')}
          disabled={!isReady}
          aria-pressed={tool === 'underline'}
          aria-label="Underline"
          title="Underline"
          style={toolButtonStyle(tool === 'underline', !isReady)}
        >
          <Underline size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectTool('arrow')}
          disabled={!isReady}
          aria-pressed={tool === 'arrow'}
          aria-label="Arrow"
          title="Arrow"
          style={toolButtonStyle(tool === 'arrow', !isReady)}
        >
          <ArrowUpRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectTool('text')}
          disabled={!isReady}
          aria-pressed={tool === 'text'}
          aria-label="Text"
          title="Text box"
          style={toolButtonStyle(tool === 'text', !isReady)}
        >
          <Type size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectStamp('star')}
          disabled={!isReady}
          aria-pressed={tool === 'stamp' && stampKind === 'star'}
          aria-label="Star stamp"
          title="Star stamp"
          style={toolButtonStyle(tool === 'stamp' && stampKind === 'star', !isReady)}
        >
          <Star size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectStamp('tick')}
          disabled={!isReady}
          aria-pressed={tool === 'stamp' && stampKind === 'tick'}
          aria-label="Tick stamp"
          title="Tick stamp"
          style={toolButtonStyle(tool === 'stamp' && stampKind === 'tick', !isReady)}
        >
          <Check size={16} />
        </button>
        <button
          type="button"
          onClick={() => selectStamp('cross')}
          disabled={!isReady}
          aria-pressed={tool === 'stamp' && stampKind === 'cross'}
          aria-label="Cross stamp"
          title="Cross stamp"
          style={toolButtonStyle(tool === 'stamp' && stampKind === 'cross', !isReady)}
        >
          <X size={16} />
        </button>

        <span style={dividerStyle} aria-hidden />

        {/* Colour (standard annotation palette). preventDefault on mouse/pointer
            down so clicking a swatch while editing does not blur (and thus
            commit/exit) the textarea -- same trick as the control-bar buttons. */}
        {COLOR_SWATCHES.map((sw) => (
          <button
            key={sw.value}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setColor(sw.value)
              // If a mark is editing or selected, recolour THAT mark too (any type,
              // undoable). Only snapshot history when the colour actually changes,
              // so re-picking a mark's current colour is a true no-op.
              const target = editingId ?? selectedId
              if (target) {
                const current = annotationsRef.current.find((a) => a.id === target)
                if (current && current.color !== sw.value) {
                  recordHistory()
                  setAnnotations((anns) =>
                    anns.map((a) => (a.id === target ? { ...a, color: sw.value } : a)),
                  )
                }
              }
            }}
            disabled={!isReady}
            aria-pressed={color === sw.value}
            aria-label={sw.label}
            title={sw.label}
            style={swatchStyle(sw.value, color === sw.value, !isReady)}
          />
        ))}

        <span style={dividerStyle} aria-hidden />

        {/* Undo / Redo / Clear */}
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo last annotation"
          title="Undo"
          style={iconButtonStyle(canUndo)}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo last annotation"
          title="Redo"
          style={iconButtonStyle(canRedo)}
        >
          <Redo2 size={16} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!canClear) return
            if (editingId) finishEditing(editingId)
            setShowClearConfirm(true)
          }}
          disabled={!canClear}
          aria-label="Clear all annotations"
          title="Clear all"
          style={iconButtonStyle(canClear)}
        >
          <Trash2 size={16} />
        </button>
          </>
        )}

        {/* Fullscreen, pushed to the right */}
        <button
          type="button"
          onClick={handleFullscreen}
          disabled={!isReady}
          title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
          style={{ ...toggleButtonStyle(isFullscreen, !isReady), marginLeft: 'auto' }}
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

        {/* Page stack + annotation overlay. The wrapper is the positioning
            context: canvases are appended imperatively into containerRef, and
            the React-managed overlay layer is an absolute sibling so the two
            never fight over the same DOM children. Both live inside the scroll
            container, so overlays scroll with their canvases automatically. */}
        <div style={{ position: 'relative', display: isReady ? 'block' : 'none' }}>
          <div ref={containerRef} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {pageRects.map((rect, pageIndex) => renderPageOverlay(rect, pageIndex))}
          </div>
        </div>
      </div>

      {/* Clear-all confirmation modal. Rendered as a child of rootRef so it is
          visible in fullscreen too (only rootRef is shown in the fullscreen top
          layer). position: fixed escapes rootRef's overflow:hidden and covers
          the viewport / fullscreen element. */}
      {showClearConfirm && (
        <div
          onClick={() => setShowClearConfirm(false)}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.45)',
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Clear all annotations"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 360,
              backgroundColor: '#ffffff',
              borderRadius: 12,
              padding: 22,
              boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 8 }}>
              Clear all annotations?
            </div>
            <div style={{ fontSize: 13.5, color: '#4b5563', lineHeight: 1.5, marginBottom: 18 }}>
              This removes every pen mark and text box on this document. This cannot be undone.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                style={{
                  height: 34,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: '1px solid #d1d5db',
                  backgroundColor: '#ffffff',
                  color: '#4b5563',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={clearAll}
                style={{
                  height: 34,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: 'none',
                  backgroundColor: '#FD5602',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// State-dependent colours via inline style (Tailwind v4 does not apply
// dynamically constructed colour classes).

// Square icon buttons (zoom, page nav, undo, redo, clear). `active` means enabled.
function iconButtonStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 34,
    height: 34,
    borderRadius: 8,
    border: `1px solid ${active ? '#d1d5db' : '#e5e7eb'}`,
    backgroundColor: active ? '#ffffff' : '#f9fafb',
    color: active ? '#4b5563' : '#9ca3af',
    cursor: active ? 'pointer' : 'not-allowed',
  }
}

// Square tool toggles (cursor / pen / text). `selected` => filled solid orange
// with a white icon; inactive => white with a slate icon; `disabled` outranks
// selection and shows the not-allowed (grey) state.
function toolButtonStyle(selected: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 34,
    height: 34,
    borderRadius: 8,
    border: `1px solid ${disabled ? '#e5e7eb' : selected ? ORANGE : '#d1d5db'}`,
    backgroundColor: disabled ? '#f9fafb' : selected ? ORANGE : '#ffffff',
    color: disabled ? '#9ca3af' : selected ? '#ffffff' : '#4b5563',
    cursor: disabled ? 'not-allowed' : 'pointer',
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

// Small control-bar buttons (A- / A+ / x). `textColor` lets the delete button
// read in a stronger colour while the size buttons stay neutral.
function controlButtonStyle(textColor: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    minWidth: 26,
    height: 24,
    padding: '0 6px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    color: textColor,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: 'inherit',
    lineHeight: 1,
  }
}

// Round colour swatch. Selected => dark ring with a white gap (visible against
// every palette colour); disabled => dimmed and not-allowed.
function swatchStyle(swatchColor: string, selected: boolean, disabled: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    flexShrink: 0,
    padding: 0,
    borderRadius: '50%',
    backgroundColor: swatchColor,
    border: '1px solid rgba(0,0,0,0.15)',
    boxShadow: selected ? '0 0 0 2px #ffffff, 0 0 0 4px #374151' : 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
}

// Page-number input in the toolbar. Small and centered; disabled state matches
// the icon buttons.
function pageInputStyle(enabled: boolean): CSSProperties {
  return {
    width: 44,
    height: 30,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: 600,
    color: enabled ? '#374151' : '#9ca3af',
    border: `1px solid ${enabled ? '#d1d5db' : '#e5e7eb'}`,
    borderRadius: 6,
    backgroundColor: enabled ? '#ffffff' : '#f9fafb',
    fontFamily: 'inherit',
    padding: '0 4px',
    cursor: enabled ? 'text' : 'not-allowed',
  }
}

const dividerStyle: CSSProperties = {
  width: 1,
  height: 22,
  flexShrink: 0,
  backgroundColor: '#e5e7eb',
}
