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
// This is the width of a NEW box and the fallback for any box saved before the
// right-edge resize handle existed (TextAnnotation.width absent).
const TEXT_BOX_WIDTH = 180
// Clamp range for a text box's stored (scale-1) width when it is dragged by its
// right-edge handle. Mirrors FONT_MIN / FONT_MAX for the font size.
const TEXT_BOX_MIN_WIDTH = 60
const TEXT_BOX_MAX_WIDTH = 600
// Clamp range for a text box's stored (scale-1) MINIMUM height when it is
// dragged by its bottom-edge / corner handle. Mirrors the width clamp above.
// A floor only: text taller than the minimum still grows the box past it.
const TEXT_BOX_MIN_HEIGHT = 24
const TEXT_BOX_MAX_HEIGHT = 800
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

// --- Cursor (selection) tool geometry ---------------------------------------
// Every cursor-tool measurement runs in RENDERED PIXEL space, never in the 0..1
// fraction space marks are stored in: fractions are anisotropic (x and y scale
// by different amounts), so any distance computed in fraction space would be
// wrong. Click tolerance around a thin stroke / arrow, in rendered px; the real
// hit width is max(renderedStrokeWidth, this).
const HIT_TOLERANCE = 8
// Total pointer travel (|dx| + |dy| in client px) at or under which a press-drag
// counts as a plain click rather than a marquee. The drag-move of a selection
// uses the SAME threshold, so both gestures agree on what a click is.
const MARQUEE_MIN_DRAG = 4
// How far a pasted copy sits from its source, in RENDERED px (converted to a
// fraction against each mark's own page). Cumulative across repeated pastes,
// because every paste re-seeds the internal clipboard with what it just placed.
const PASTE_OFFSET_PX = 16
// How far the arrowhead reaches from an arrow's END point, in multiples of the
// RENDERED line width. Derived from the marker attributes at the render site
// (viewBox "0 0 10 10", markerWidth / markerHeight 8, refX 8, refY 5, and the
// default markerUnits "strokeWidth"): one viewBox unit is 8/10 = 0.8 line
// widths, and the reference point sits at (8, 5) inside the marker viewport. So
// the head reaches 8 * 0.8 back along the line, 8 * 0.2 past the tip, and 8 / 2
// to each side. Keep these in step with that <marker> if it is ever retuned.
const ARROW_HEAD_BACK = 6.4
const ARROW_HEAD_FRONT = 1.6
const ARROW_HEAD_SIDE = 4

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

// Which toolbar control (if any) the pointer is currently over. Colour swatches reuse
// AnnColor directly since each swatch value is already a unique string; every other
// control gets one literal name. Powers hoverFilterStyle only -- never read by any
// click handler or annotation logic.
type ToolbarHoverKey =
  | 'zoomOut'
  | 'zoomIn'
  | 'fitWidth'
  | 'prevPage'
  | 'nextPage'
  | 'cursor'
  | 'pen'
  | 'highlighter'
  | 'underline'
  | 'arrow'
  | 'text'
  | 'stampStar'
  | 'stampTick'
  | 'stampCross'
  | 'undo'
  | 'redo'
  | 'clear'
  | 'fullscreen'
  | 'colorDot'
  | AnnColor

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
  // Wrapping / editing width in scale-1 px, same convention as fontSize
  // (rendered width = width * scale). Set by dragging the box's right-edge
  // handle; the vertical axis lives in the separate `height` field below.
  // ABSENT = a box saved before the handle existed: it renders EXACTLY as it
  // always has, through the TEXT_BOX_WIDTH fallback at both read sites. Optional
  // and numeric, so the annotations array stays JSON-serializable (it is
  // persisted as-is to lesson_annotations).
  width?: number
  // MINIMUM box height in scale-1 px, same convention as width / fontSize
  // (rendered height = height * scale). Set by dragging the box's bottom-edge or
  // corner handle. A MINIMUM and never a fixed size: the box still grows past it
  // to fit its text, so no character can ever be clipped or hidden. ABSENT (or a
  // null / NaN that came back from the jsonb column) = a purely content-driven
  // height, exactly as before these handles existed. Optional and numeric, so
  // the annotations array stays JSON-serializable (it is persisted as-is to
  // lesson_annotations).
  height?: number
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

// Stable shared empty-selection reference, mirroring EMPTY_ANNOTATIONS above.
// selectedIds is always REPLACED, never mutated in place, so one shared array is
// safe to reuse -- and reusing it keeps "deselect when nothing is selected" a
// true no-op (React bails out on an identical reference), exactly as the old
// setSelectedId(null) did when the id was already null.
const NO_SELECTION: string[] = []

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
// In-progress SIZE resize of a text box (refs only; never rendered).
// Deliberately NOT DragState: a resize needs the box's start WIDTH / HEIGHT, not
// its origin x/y and page size, and widening DragState would change the shape
// every existing move-drag caller (text + stamp) reads. Only one of the two can
// run at a time -- the handle is a sibling of the box and stops propagation, so
// a grab never starts a move -- but they stay in separate refs so neither can
// see the other's state.
interface ResizeState {
  id: string
  // Which axis (or axes) the grabbed handle drives. The move handler writes ONLY
  // the field(s) this names, so an edge drag can never silently stamp the other
  // axis onto a box that has nothing stored for it.
  axis: 'x' | 'y' | 'both'
  startX: number
  startY: number
  startWidth: number // scale-1 px at pointer-down (t.width ?? TEXT_BOX_WIDTH)
  startHeight: number // scale-1 px at pointer-down (t.height, else the measured rendered height)
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
// A rectangle in RENDERED px, relative to a page overlay's top-left corner.
// Cursor-tool hit testing and marquee intersection both work in this space.
interface PxRect {
  left: number
  top: number
  right: number
  bottom: number
}
// In-progress marquee (rubber-band) drag; cursor tool only, and always local to
// the ONE page the drag started on. `x0/y0` is the anchor in overlay-local px;
// the pointer-down client coords are kept so the click-vs-drag threshold is
// measured in raw pointer travel, independent of zoom.
interface MarqueeDrag {
  pageIndex: number
  // The pointer that ARMED the drag. Every later event must match it, so a
  // second pointer (a palm or a stray finger landing while the pen is
  // mid-marquee) can never drive, commit or cancel someone else's gesture.
  pointerId: number
  clientX: number
  clientY: number
  x0: number
  y0: number
  additive: boolean // shift held at pointer-down: ADD to the existing selection
  moved: boolean
}
// The marquee as rendered: page-local px corners on ONE page.
interface MarqueeRect {
  pageIndex: number
  x0: number
  y0: number
  x1: number
  y1: number
}
// Per-page geometry + delta limits for a translation (a drag-move or a paste),
// computed once per gesture. `pages` holds the RENDERED size of every page that
// carries a mark being translated, so ONE px delta converts into that page's own
// (anisotropic) fraction space. The four scalars are the px delta range --
// intersected across every page involved -- within which no page's union
// bounding box leaves 0..1. The DELTA is clamped, never the individual points:
// clamping points would deform a stroke instead of moving it.
interface MoveLimits {
  pages: Map<number, { w: number; h: number }>
  dxLo: number
  dxHi: number
  dyLo: number
  dyHi: number
}
// In-progress drag-move of the selection (cursor tool, mouse / pen only).
interface MoveDrag {
  // The pointer that ARMED the drag, exactly like MarqueeDrag: every later event
  // must match it, so a second pointer (a palm, a stray finger) can never drive
  // or end someone else's gesture.
  pointerId: number
  clientX: number
  clientY: number
  // Pre-drag geometry of every mark being moved, keyed by its ARRAY INDEX (the
  // id is re-checked on every move). Index-keyed rather than id-keyed so a legacy
  // payload carrying duplicate ids cannot make one mark be replaced by a copy of
  // the other, and so a mid-drag array change makes the drag stop instead of
  // translating the wrong mark. Each move translates from THIS snapshot rather
  // than incrementally, so the drag is idempotent and cannot accumulate drift.
  origins: Map<number, Annotation>
  limits: MoveLimits
  moved: boolean
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

// --- Cursor-tool geometry (every input and output is in RENDERED px) --------

// Pointer position relative to a page overlay, clamped to the page, together
// with that page's rendered size. One getBoundingClientRect for both, since
// every cursor-tool computation needs the pair.
function overlayPoint(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect()
  const w = r.width
  const h = r.height
  return {
    x: w > 0 ? clamp01((clientX - r.left) / w) * w : 0,
    y: h > 0 ? clamp01((clientY - r.top) / h) * h : 0,
    w,
    h,
  }
}

// Standard rect intersection: ANY overlap counts (the Figma / Miro marquee rule,
// deliberately NOT full enclosure).
function rectsOverlap(a: PxRect, b: PxRect): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
}

// Shortest distance from (px, py) to the segment (ax, ay)-(bx, by).
function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  const raw = ((px - ax) * vx + (py - ay) * vy) / len2
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

// How a text box's rendered box is obtained. The DOM is the ONLY source of truth
// for text size (never an estimate from character count), so this is supplied by
// the component from its live element map.
type TextBoxMeasure = (id: string) => PxRect | null
// For call sites that can never be handed a text annotation (the stroke / arrow
// selection outlines), so no measurement is needed.
const NO_TEXT_MEASURE: TextBoxMeasure = () => null

// Painting order inside a page overlay: the svg draws strokes, then arrows, then
// stamps, and the text boxes are DOM siblings AFTER that svg, so text always
// paints on top. Higher rank = drawn later; ties are broken by array order at
// the call site. Used to resolve overlapping hits ("topmost wins").
function layerRank(a: Annotation): number {
  return a.type === 'stroke' ? 0 : a.type === 'arrow' ? 1 : a.type === 'shape' ? 2 : 3
}

// Rendered bounding box of one annotation in overlay-local px; w/h are the
// page's rendered size. Returns null when the box cannot be determined (a text
// box with no mounted node, or a stroke with no points), which every caller
// treats as "not selectable".
function annotationBounds(
  a: Annotation,
  w: number,
  h: number,
  scale: number,
  measureText: TextBoxMeasure,
): PxRect | null {
  if (a.type === 'text') return measureText(a.id)
  if (a.type === 'shape') {
    // The rendered square -- the same box the stamp's selection rect surrounds.
    const half = (a.size * scale) / 2
    const cx = a.x * w
    const cy = a.y * h
    return { left: cx - half, top: cy - half, right: cx + half, bottom: cy + half }
  }
  if (a.type === 'arrow') {
    const lineW = a.width * scale
    const half = lineW / 2
    const sx = a.start.x * w
    const sy = a.start.y * h
    const ex = a.end.x * w
    const ey = a.end.y * h
    // The line itself, padded by half its rendered width.
    let minX = Math.min(sx, ex) - half
    let minY = Math.min(sy, ey) - half
    let maxX = Math.max(sx, ex) + half
    let maxY = Math.max(sy, ey) + half
    // Then grow to cover the arrowhead drawn at the END point. The head rotates
    // with the line (orient="auto"), so fold in the four corners of its marker
    // viewport expressed in the arrow's own frame -- padding isotropically by
    // its longest reach instead would inflate the box by ~2x across a
    // horizontal arrow, which shows up directly as a too-tall selection outline.
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.hypot(dx, dy)
    if (len === 0) {
      // No direction to orient the head by: fall back to its longest reach.
      const r = ARROW_HEAD_BACK * lineW
      minX = Math.min(minX, ex - r)
      minY = Math.min(minY, ey - r)
      maxX = Math.max(maxX, ex + r)
      maxY = Math.max(maxY, ey + r)
    } else {
      const ux = dx / len
      const uy = dy / len
      for (const along of [-ARROW_HEAD_BACK * lineW, ARROW_HEAD_FRONT * lineW]) {
        for (const side of [-ARROW_HEAD_SIDE * lineW, ARROW_HEAD_SIDE * lineW]) {
          const cx = ex + ux * along - uy * side
          const cy = ey + uy * along + ux * side
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
        }
      }
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY }
  }
  const half = (a.width * scale) / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of a.points) {
    const x = p.x * w
    const y = p.y * h
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { left: minX - half, top: minY - half, right: maxX + half, bottom: maxY + half }
}

// Does a click at (px, py) hit this annotation? Strokes and arrows use a
// distance-to-segment test so a thin line still has a usable click target (a
// single-point stroke -- a dot / tap -- is treated as a point with the same
// tolerance); stamps and text boxes use their rendered box.
function annotationHitsPoint(
  a: Annotation,
  px: number,
  py: number,
  w: number,
  h: number,
  scale: number,
  measureText: TextBoxMeasure,
): boolean {
  if (a.type === 'stroke') {
    const tolerance = Math.max(a.width * scale, HIT_TOLERANCE)
    const pts = a.points
    const first = pts[0]
    if (!first) return false
    if (pts.length === 1) return Math.hypot(px - first.x * w, py - first.y * h) <= tolerance
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]
      const q = pts[i + 1]
      if (!p || !q) continue
      if (pointSegmentDistance(px, py, p.x * w, p.y * h, q.x * w, q.y * h) <= tolerance) return true
    }
    return false
  }
  if (a.type === 'arrow') {
    const tolerance = Math.max(a.width * scale, HIT_TOLERANCE)
    return pointSegmentDistance(px, py, a.start.x * w, a.start.y * h, a.end.x * w, a.end.y * h) <= tolerance
  }
  const b = annotationBounds(a, w, h, scale, measureText)
  return b !== null && px >= b.left && px <= b.right && py >= b.top && py <= b.bottom
}

// --- Translation (drag-move and paste) --------------------------------------

function clampRange(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

// The stored 0..1 coordinates a translation actually moves: every point of a
// stroke, both endpoints of an arrow, and the single anchor of a text box /
// stamp. Feeds the union bounding box the delta clamp works against.
function annotationPoints(a: Annotation): { x: number; y: number }[] {
  if (a.type === 'stroke') return a.points
  if (a.type === 'arrow') return [a.start, a.end]
  return [{ x: a.x, y: a.y }]
}

// Delta limits for translating `marks`. Per page, the union box of their stored
// fractions may not leave 0..1, which becomes a px range for that page (fraction
// x that page's RENDERED size). The ranges are INTERSECTED across pages, so one
// page pinned against an edge stops the whole multi-page gesture -- that is what
// "clamp the delta, not the coordinates" means for a multi-mark selection. A
// mark on a page with no measured rect is skipped: it cannot be converted to px,
// so it simply does not move and constrains nothing.
function moveLimits(marks: Annotation[], rects: PageRect[]): MoveLimits {
  const per = new Map<
    number,
    { w: number; h: number; minX: number; minY: number; maxX: number; maxY: number }
  >()
  for (const a of marks) {
    const rect = rects[a.pageIndex]
    if (!rect || rect.width <= 0 || rect.height <= 0) continue
    let box = per.get(a.pageIndex)
    if (!box) {
      box = { w: rect.width, h: rect.height, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      per.set(a.pageIndex, box)
    }
    for (const p of annotationPoints(a)) {
      if (p.x < box.minX) box.minX = p.x
      if (p.x > box.maxX) box.maxX = p.x
      if (p.y < box.minY) box.minY = p.y
      if (p.y > box.maxY) box.maxY = p.y
    }
  }
  const pages = new Map<number, { w: number; h: number }>()
  let dxLo = -Infinity
  let dxHi = Infinity
  let dyLo = -Infinity
  let dyHi = Infinity
  for (const [pageIndex, box] of per) {
    pages.set(pageIndex, { w: box.w, h: box.h })
    // A page whose marks carry no coordinates at all (only an empty stroke) has
    // nothing to keep on the page, so it constrains nothing.
    if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY)) continue
    dxLo = Math.max(dxLo, -box.minX * box.w)
    dxHi = Math.min(dxHi, (1 - box.maxX) * box.w)
    dyLo = Math.max(dyLo, -box.minY * box.h)
    dyHi = Math.min(dyHi, (1 - box.maxY) * box.h)
  }
  return { pages, dxLo, dxHi, dyLo, dyHi }
}

// Move one mark by a FRACTION delta (already clamped by the caller), returning a
// NEW object that shares no nested point with the original. `id` is a parameter
// so the same helper serves the drag (keep the id) and paste (mint a fresh one);
// pageIndex, colour, width, opacity, text, size and kind all carry over
// untouched, so the saved payload shape is identical. Each union member is
// spread in its own branch so the result stays a narrowed Annotation.
function translateAnnotation(a: Annotation, fdx: number, fdy: number, id: string): Annotation {
  if (a.type === 'stroke') {
    return { ...a, id, points: a.points.map((p) => ({ x: p.x + fdx, y: p.y + fdy })) }
  }
  if (a.type === 'arrow') {
    return {
      ...a,
      id,
      start: { x: a.start.x + fdx, y: a.start.y + fdy },
      end: { x: a.end.x + fdx, y: a.end.y + fdy },
    }
  }
  if (a.type === 'text') return { ...a, id, x: a.x + fdx, y: a.y + fdy }
  return { ...a, id, x: a.x + fdx, y: a.y + fdy }
}

// Deep copy of one mark: the translate helper with a zero delta, so the copy
// shares no nested object with the original.
function cloneAnnotation(a: Annotation): Annotation {
  return translateAnnotation(a, 0, 0, a.id)
}

// Editable text box: a focused, auto-growing textarea. Kept as its own
// component so the focus + auto-height effects have a stable home (the parent
// renders overlays from a plain map, which cannot host hooks).
function EditableTextBox({
  value,
  widthPx,
  minHeightPx,
  fontSizePx,
  onChangeText,
  onCommit,
  style,
}: {
  value: string
  widthPx: number
  // Rendered floor for the auto-grow height, never a cap. 0 for a box with no
  // stored height, which makes the Math.max below a no-op.
  minHeightPx: number
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

  // Grow to fit content height whenever the text, width, font size or dragged
  // minimum height changes (font size is included so A- / A+ resize the box live
  // while editing; minHeightPx so dragging the height handle mid-edit grows the
  // box live instead of waiting for the next keystroke -- leave it OUT of the
  // dependency array and the box simply will not follow the handle). scrollHeight
  // is the floor the CONTENT needs, so taking the max can only ever ADD space:
  // a minimum can never clip or hide a character.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, minHeightPx)}px`
  }, [value, widthPx, fontSizePx, minHeightPx])

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
  // In-progress text-box SIZE resize (its own ref, see ResizeState: the move
  // drag's semantics and dragRef are untouched by it).
  const resizeRef = useRef<ResizeState | null>(null)
  // In-progress marquee drag (cursor tool). A ref as well as state because the
  // move / up handlers must read it synchronously, and because the click-vs-drag
  // threshold flips `moved` without a re-render.
  const marqueeRef = useRef<MarqueeDrag | null>(null)
  // In-progress drag-move of the selection (cursor tool). A ref for the same
  // reasons as marqueeRef: the move / up handlers must read it synchronously, and
  // the click-vs-drag threshold flips `moved` without a re-render. Only one of
  // the two is ever armed -- a press either hits a mark (move) or lands on empty
  // space (marquee).
  const moveRef = useRef<MoveDrag | null>(null)
  // INTERNAL copy/paste clipboard -- deliberately not the system clipboard and no
  // clipboard API: it holds whole Annotation objects no other app could consume,
  // and lesson marks must not leave the page. It survives deselect and tool
  // switches, is re-seeded by each paste so repeated pastes stack, and is cleared
  // by the document-load effect alongside the marquee.
  const clipboardRef = useRef<Annotation[]>([])
  // Live DOM nodes of the committed text boxes, keyed by annotation id, so the
  // cursor tool can hit-test / marquee against a text box's REAL rendered size
  // instead of estimating it from character count. Registered by renderTextBox's
  // wrapper ref (which exists in both its editing and committed branches) and
  // deleted when that wrapper unmounts.
  const textBoxElsRef = useRef<Map<string, HTMLElement>>(new Map())
  // Pre-gesture annotation snapshot, captured at drag-start and pushed onto the
  // undo stack only if the drag actually moved the box (so a live drag's many
  // per-pixel updates collapse into one undo step). See onTextPointerUp.
  const pendingPastRef = useRef<Annotation[] | null>(null)
  // Always mirrors the latest annotations (kept in sync by an effect below) so
  // history snapshots read the true-current array, never a stale closure value.
  const annotationsRef = useRef<Annotation[]>([])
  // Always mirrors the live `currentPage` (1-based; kept in sync by an effect
  // below, same pattern as annotationsRef) so the paste handler can read the page
  // the reader is LOOKING AT without taking currentPage as a dependency: it
  // changes on every scroll, which would re-subscribe the key listener constantly.
  const currentPageRef = useRef(1)
  // Latest initialAnnotations, mirrored so the document-load effect can seed
  // from the current prop WITHOUT taking initialAnnotations as a dependency
  // (which would re-run the whole load -- and wipe edits -- on every new array).
  // Synced by an effect declared just before the load effect.
  const initialAnnotationsRef = useRef<Annotation[] | undefined>(initialAnnotations)
  // Latest onAnnotationsChange, mirrored so the annotations-change effect always
  // calls the current callback and can depend only on the annotations array (a
  // new function identity from the parent never re-fires it on its own).
  const onAnnotationsChangeRef = useRef<((annotations: Annotation[]) => void) | undefined>(onAnnotationsChange)
  // Wraps the colour-dot trigger + popover so an outside pointer-down can be
  // detected (target not contained) and close the open popover. See the colorOpen
  // effect below.
  const colorMenuRef = useRef<HTMLDivElement | null>(null)

  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [scale, setScale] = useState(1.2)
  // Fit-to-width mode: while on, the scale tracks the container width (and
  // re-tracks on resize). Any manual zoom releases it.
  const [fitMode, setFitMode] = useState(true)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // Editable page-number box. null when not being edited (the box then shows the
  // live current page); a string while the user is typing a page to jump to.
  const [pageDraft, setPageDraft] = useState<string | null>(null)

  const [isFullscreen, setIsFullscreen] = useState(false)

  // Which toolbar control (if any) is currently under the pointer; drives the hover
  // tint only (hoverFilterStyle) -- never read by click handlers or annotation logic.
  // null = nothing hovered, matching editingId below.
  const [hoverKey, setHoverKey] = useState<ToolbarHoverKey | null>(null)

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
  // Whether the colour popover (the single dot that folds the 8 swatches) is
  // open. Purely presentational: it gates the popover and never touches the
  // selected colour, any mark, or the save path.
  const [colorOpen, setColorOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  // The rubber-band rectangle while a marquee drag is running (cursor tool), or
  // null. Purely transient UI: it lives on ONE page, never touches `annotations`
  // and never records history, exactly like the selection it produces.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)
  // A mark is either being EDITED (textarea) or SELECTED (outlined, with a
  // control bar) -- never both. Editing is single by nature; SELECTION is a LIST
  // so several marks can be held at once. Only single selection is reachable
  // today: every current path sets exactly one id ([id]) and every deselect path
  // sets the shared empty array. The two states stay mutually exclusive through
  // enterEdit / selectBox below (entering edit clears the selection, selecting
  // clears editing).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>(NO_SELECTION)
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

  // The cursor tool is a real SELECTION tool only in an editable viewer. In
  // read-only review mode it stays exactly what it has always been: an inert,
  // click-through overlay. Every new selection path is gated on this.
  const cursorSelect = tool === 'cursor' && !readOnly

  // useCallback (over a plain function) purely so the copy/paste key effect can
  // list it as a dependency without re-subscribing its listener on every render.
  // It reads and bumps a ref only, so the identity is genuinely stable and every
  // existing call site behaves byte-for-byte as before.
  const nextId = useCallback((): string => {
    idCounterRef.current += 1
    return `a${idCounterRef.current}`
  }, [])

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
      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : prev))
      setEditingId((prev) => (prev === id ? null : prev))
    },
    [recordHistory],
  )

  // Delete EVERY currently selected mark as ONE undoable step: a single
  // recordHistory() and a single setAnnotations, so one undo brings them all
  // back together (and the change callback fires once). deleteBox above stays
  // the single-id path used by the per-object control-bar x buttons. No-op when
  // nothing is selected -- and specifically no history entry, so an empty
  // Delete press never leaves a phantom undo step.
  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return
    const doomed = new Set(selectedIds)
    recordHistory()
    setAnnotations((anns) => anns.filter((a) => !doomed.has(a.id)))
    setSelectedIds(NO_SELECTION)
    setEditingId(null)
  }, [selectedIds, recordHistory])

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
    setFitMode(true)
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
    // Ids are minted as a1, a2, ... from a counter that starts at 0 on EVERY
    // mount, while a seed carries the ids an EARLIER mount minted and saved. So
    // advance the counter past every a<N> in the seed: without this the first new
    // mark (or the first paste) on a seeded document re-mints an id the seed
    // already uses, and duplicate ids break React keys, make delete / recolour hit
    // both marks, and let a drag-move overwrite one mark with a copy of the other.
    // The counter only ever grows, so ids stay unique across document swaps too.
    for (const a of seed) {
      const m = /^a(\d+)$/.exec(a.id)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isFinite(n) && n > idCounterRef.current) idCounterRef.current = n
    }
    if (annotationsRef.current !== seed) isSeedingRef.current = true
    setAnnotations(seed)
    setEditingId(null)
    setSelectedIds(NO_SELECTION)
    setDraft(null)
    // Any in-progress marquee dies with the old document: its rubber band is in
    // the old page's geometry, and leaving the drag armed would let the next
    // hover paint a stale rectangle.
    marqueeRef.current = null
    setMarquee(null)
    // Same reasoning for an in-progress drag-move (its origin geometry belongs to
    // the old document) and for the internal clipboard (pasting the old
    // document's marks here would place them by fractions that mean nothing on
    // these pages, and could land on a page index that no longer exists).
    moveRef.current = null
    clipboardRef.current = []
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

  // Default view: fit the page to the available width as soon as the document
  // is ready (and again whenever fit mode is re-entered). Manual zoom releases
  // fit mode via the existing zoomIn/zoomOut paths.
  useEffect(() => {
    if (status !== 'ready') return
    if (!fitMode) return
    applyFitWidth()
  }, [status, fitMode, applyFitWidth])

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

  // Mirrors fitMode for the ResizeObserver callback below, which must read the
  // live value without listing fitMode as an effect dependency (that would
  // re-create the observer on every fit toggle).
  const fitModeRef = useRef(fitMode)
  useEffect(() => {
    fitModeRef.current = fitMode
  }, [fitMode])

  // Re-measure overlay geometry on any container size change: window resize,
  // fullscreen transition, scrollbar appearance, and the margin:auto centring
  // shift that a width change causes. (Zoom is already handled by the render
  // pass above; this covers the size changes that do NOT re-render the pages.)
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      measurePages()
      if (fitModeRef.current) applyFitWidth()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [measurePages, applyFitWidth])

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

  // Close the colour popover on Escape or an outside pointer-down. Mirrors the
  // clear-confirm Escape effect above: listeners are attached ONLY while the
  // popover is open. Picking a swatch does NOT close it (a mark can be tried
  // against several colours in a row); it closes on Escape, an outside
  // pointer-down (ref-gated -- a press inside the dot/popover wrapper is
  // ignored), or clicking the dot again. Presentation only.
  useEffect(() => {
    if (!colorOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setColorOpen(false)
    }
    function onPointerDown(e: PointerEvent) {
      const wrap = colorMenuRef.current
      if (wrap && !wrap.contains(e.target as Node)) setColorOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [colorOpen])

  // Delete / Backspace removes the selection. Attached ONLY while something is
  // selected and NOT being edited, so it never competes with the textarea (where
  // Backspace must edit text). Also guards against any other form control (e.g.
  // the page-number input) being focused, since typing in it must never delete
  // marks. Routed through deleteSelected so the key-delete is recorded in
  // history like every other delete, and so a multi-selection is removed as a
  // single undo step.
  useEffect(() => {
    if (selectedIds.length === 0 || editingId) return
    function onKey(e: KeyboardEvent) {
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedIds, editingId, deleteSelected])

  // Escape clears the CURSOR tool's selection. Attached ONLY while the cursor
  // tool actually has a selection and nothing is being edited, so it never
  // competes with the textarea's own Escape (which commits the box) and leaves
  // every other tool's behaviour untouched. Clearing a selection is not an
  // undoable action, so nothing is recorded.
  useEffect(() => {
    if (!cursorSelect) return
    if (selectedIds.length === 0 || editingId) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedIds(NO_SELECTION)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [cursorSelect, selectedIds, editingId])

  // Mirror the live page number into a ref for the paste handler below. Kept as a
  // ref rather than a dependency on purpose -- see currentPageRef's declaration.
  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  // Ctrl/Cmd + C / V against the INTERNAL clipboard (clipboardRef) -- never the
  // system clipboard and no clipboard API, so nothing leaves the page. Copy deep-
  // copies the selection and changes nothing else: no state, no history. Paste
  // mints fresh ids, lands every copy on the page CURRENTLY BEING VIEWED (the
  // PowerPoint slide-paste model -- see the paste branch) and appends them in
  // ONE setAnnotations behind ONE recordHistory, so a whole paste is a single
  // undo step, then selects the pasted set. Guards mirror the Delete listener
  // above: never in read-only, never while a text box is being edited, and never
  // while a form control (e.g. the page-number input) has focus. Paste only
  // lands in cursor mode, so the pasted selection's outline is always clearable
  // by Escape.
  useEffect(() => {
    if (readOnly) return
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      // AltGr on international Windows layouts reports ctrlKey AND altKey, so an
      // AltGr chord must never be read as Ctrl+C / Ctrl+V.
      if (e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== 'c' && key !== 'v') return
      if (editingId) return
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (key === 'c') {
        if (selectedIds.length === 0) return
        // Filter the annotations array (not selectedIds) so the copies keep their
        // painting order. Deliberately NOT preventDefault: the browser's own copy
        // of a real text selection elsewhere on the page must keep working -- this
        // clipboard is separate and purely additive.
        const wanted = new Set(selectedIds)
        clipboardRef.current = annotationsRef.current.filter((a) => wanted.has(a.id)).map(cloneAnnotation)
        return
      }
      if (!cursorSelect) return
      const clip = clipboardRef.current
      if (clip.length === 0) return
      e.preventDefault()
      // Slide-paste model (PowerPoint): the copies land on the page the reader is
      // LOOKING AT, not on the page each was copied from, so a multi-page
      // selection collapses onto this one page.
      const targetPage = currentPageRef.current - 1
      // Re-page FIRST, then clamp: the limits -- and the px -> fraction
      // conversion -- must both be computed against the TARGET page's rendered
      // size, so a mark arriving from a differently sized page still cannot land
      // outside 0..1. `sameSource` is captured here because the re-paged copy no
      // longer remembers where it came from.
      const retargeted: { mark: Annotation; sameSource: boolean }[] = clip.map((a) => {
        const sameSource = a.pageIndex === targetPage
        return { mark: sameSource ? a : { ...a, pageIndex: targetPage }, sameSource }
      })
      // The +16px offset runs through the SAME union-delta clamp as a drag, so a
      // paste can never land outside the page.
      const limits = moveLimits(
        retargeted.map((r) => r.mark),
        pageRects,
      )
      const dx = clampRange(PASTE_OFFSET_PX, limits.dxLo, limits.dxHi)
      const dy = clampRange(PASTE_OFFSET_PX, limits.dyLo, limits.dyHi)
      // Undefined when the target page has no measured rect: the marks then paste
      // with a zero offset rather than not at all.
      const targetRect = limits.pages.get(targetPage)
      const pasted = retargeted.map(({ mark, sameSource }) => {
        // A mark copied FROM the viewed page keeps the historical +16px stagger
        // (cumulative, because each paste re-seeds the clipboard with what it
        // placed); one arriving from another page lands at its identical stored
        // fraction, so a collapsed group keeps its relative layout.
        const p = sameSource ? targetRect : undefined
        return translateAnnotation(mark, p ? dx / p.w : 0, p ? dy / p.h : 0, nextId())
      })
      recordHistory()
      setAnnotations((anns) => [...anns, ...pasted])
      setSelectedIds(pasted.map((a) => a.id))
      // Re-seed the clipboard with what was just placed -- it now carries the
      // TARGET pageIndex, so a repeat paste on this page counts as same-source and
      // stacks visibly. Annotations are never mutated in place, so sharing these
      // objects with the annotations array is safe.
      clipboardRef.current = pasted
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [readOnly, editingId, selectedIds, pageRects, recordHistory, nextId, cursorSelect])

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
    setSelectedIds(NO_SELECTION)
    setEditingId(id)
  }

  // Select `id` (the click / post-drag state) as the ONLY selection. Commits any
  // other open edit first, then makes selection and editing mutually exclusive.
  // Selection is not an undoable action, so it does NOT record history.
  function selectBox(id: string) {
    if (editingId && editingId !== id) finishEditing(editingId)
    setEditingId(null)
    setSelectedIds([id])
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
    setSelectedIds(NO_SELECTION)
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
    setSelectedIds(NO_SELECTION)
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
    setSelectedIds(NO_SELECTION)
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
    setSelectedIds(NO_SELECTION)
    setDraft(null)
  }

  function clearAll() {
    recordHistory()
    setAnnotations([])
    setEditingId(null)
    setSelectedIds(NO_SELECTION)
    setDraft(null)
    setShowClearConfirm(false)
  }

  // --- Cursor (selection) tool ----------------------------------------------

  // Measure the committed text boxes of ONE page overlay, in overlay-local px.
  // Built once per gesture from the live DOM (the only source of truth for a
  // text box's rendered size); a box with no mounted node measures to null and
  // is therefore not selectable.
  function measureTextBoxes(overlay: HTMLElement): TextBoxMeasure {
    const or = overlay.getBoundingClientRect()
    return (id: string) => {
      const el = textBoxElsRef.current.get(id)
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return null
      return {
        left: r.left - or.left,
        top: r.top - or.top,
        right: r.right - or.left,
        bottom: r.bottom - or.top,
      }
    }
  }

  // Drop an in-progress marquee, leaving the selection exactly as it was.
  function cancelMarquee() {
    marqueeRef.current = null
    setMarquee(null)
  }

  // Does this event belong to the pointer that armed the current marquee? Touch
  // can never arm one (the cursor branch bails on it), so a touch event is
  // rejected outright rather than relying on pointer ids alone -- a finger must
  // keep scrolling the document even while a pen marquee is running.
  function ownsMarquee(e: ReactPointerEvent<HTMLDivElement>): MarqueeDrag | null {
    const m = marqueeRef.current
    if (!m) return null
    if (e.pointerType === 'touch') return null
    return e.pointerId === m.pointerId ? m : null
  }

  // Extend an armed marquee. A no-op under every other tool, because marqueeRef
  // is only ever armed by the cursor branch of onOverlayPointerDown.
  function updateMarquee(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    const m = ownsMarquee(e)
    if (!m) return
    // Self-heal, checked BEFORE the page guard so it still fires when the
    // pointer has wandered onto another page: a pointer-up we never saw (release
    // outside the window, alt-tab, a gesture stolen by the OS) would otherwise
    // leave the drag armed and let a plain hover paint a marquee.
    if (e.buttons === 0) {
      cancelMarquee()
      return
    }
    // Geometry is only meaningful against the page the drag started on (with
    // pointer capture held, that is the only overlay these events reach).
    if (m.pageIndex !== pageIndex) return
    if (!m.moved && Math.abs(e.clientX - m.clientX) + Math.abs(e.clientY - m.clientY) <= MARQUEE_MIN_DRAG) {
      return
    }
    m.moved = true
    const pt = overlayPoint(e.currentTarget, e.clientX, e.clientY)
    setMarquee({ pageIndex, x0: m.x0, y0: m.y0, x1: pt.x, y1: pt.y })
  }

  // Complete an armed marquee on pointer-up: a real drag selects every mark on
  // THIS page whose bounding box INTERSECTS the rectangle (partial overlap is
  // enough), a sub-threshold drag is a plain click. Selection is not undoable,
  // so nothing here touches the annotations array or the history stacks.
  function finishMarquee(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    const m = ownsMarquee(e)
    if (!m) return
    cancelMarquee()
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    // The gesture must end on the page it started on -- it always does while
    // pointer capture holds, but capture is best-effort. If it was refused and
    // the release landed on another page, drop the gesture (state is already
    // clean) rather than selecting from a rectangle measured against the wrong
    // page geometry.
    if (m.pageIndex !== pageIndex) return
    if (!m.moved) {
      // A plain click on empty space clears the selection. With shift held it is
      // left alone: an additive gesture that caught nothing must never wipe what
      // is already selected.
      if (!m.additive) setSelectedIds(NO_SELECTION)
      return
    }
    const pt = overlayPoint(el, e.clientX, e.clientY)
    const box: PxRect = {
      left: Math.min(m.x0, pt.x),
      top: Math.min(m.y0, pt.y),
      right: Math.max(m.x0, pt.x),
      bottom: Math.max(m.y0, pt.y),
    }
    const measure = measureTextBoxes(el)
    const hits: string[] = []
    for (const a of annotations) {
      if (a.pageIndex !== pageIndex) continue
      const b = annotationBounds(a, pt.w, pt.h, scale, measure)
      if (b && rectsOverlap(b, box)) hits.push(a.id)
    }
    setSelectedIds((prev) => {
      if (!m.additive) return hits.length === 0 ? NO_SELECTION : hits
      const merged = prev.slice()
      for (const id of hits) if (!merged.includes(id)) merged.push(id)
      // Nothing new caught: keep the exact previous array so React bails out.
      return merged.length === prev.length ? prev : merged
    })
  }

  // Does this event belong to the pointer that armed the current drag-move?
  // Mirrors ownsMarquee, including the outright touch rejection: touch can never
  // arm a move (the cursor branch bails before anything), and a finger must keep
  // scrolling the document even while a pen drag is running.
  function ownsMove(e: ReactPointerEvent<HTMLDivElement>): MoveDrag | null {
    const m = moveRef.current
    if (!m) return null
    if (e.pointerType === 'touch') return null
    return e.pointerId === m.pointerId ? m : null
  }

  // Forget an armed drag-move and push its pre-drag snapshot as ONE undo step --
  // but only if the gesture actually moved something, so a plain select-click
  // adds nothing to history (the same rule, and the same pendingPastRef, as the
  // text-box and stamp drags, which can never be armed at the same time as this
  // one: different tools). Shared by the normal pointer-up path (finishMove) and
  // by the stale-drag sweep at the start of the next cursor gesture, which is why
  // it takes no event and pushes rather than discards: dropping the snapshot
  // would make the next undo jump straight past that move.
  function commitMove() {
    const m = moveRef.current
    if (!m) return
    moveRef.current = null
    if (m.moved) {
      const snap = pendingPastRef.current
      if (snap) {
        setPast((p) => (p.length >= HISTORY_LIMIT ? [...p.slice(1), snap] : [...p, snap]))
        setFuture([])
      }
    }
    pendingPastRef.current = null
  }

  // End an armed drag-move on ITS OWN pointer, returning true when the event
  // belonged to it.
  function finishMove(e: ReactPointerEvent<HTMLDivElement>): boolean {
    if (!ownsMove(e)) return false
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    commitMove()
    return true
  }

  // Translate every selected mark to follow an armed drag. Returns true when the
  // event belonged to that drag, so the caller knows not to fall through to the
  // marquee. Deliberately page-INDEPENDENT (no pageIndex guard, unlike the
  // marquee): the delta is measured in client px and converted against each
  // mark's OWN page, so the gesture stays correct even if pointer capture was
  // refused and the events land on a different page's overlay.
  function updateMove(e: ReactPointerEvent<HTMLDivElement>): boolean {
    const m = ownsMove(e)
    if (!m) return false
    // Self-heal a pointer-up we never saw (released outside the window, alt-tab,
    // a gesture stolen by the OS): end the drag where it stands rather than leave
    // it armed, which would let a plain hover keep dragging the marks around.
    if (e.buttons === 0) {
      finishMove(e)
      return true
    }
    const rawDx = e.clientX - m.clientX
    const rawDy = e.clientY - m.clientY
    // Same click-vs-drag threshold as the marquee, measured on RAW pointer travel
    // so it is independent of zoom and of the clamp below.
    if (!m.moved && Math.abs(rawDx) + Math.abs(rawDy) <= MARQUEE_MIN_DRAG) return true
    const dx = clampRange(rawDx, m.limits.dxLo, m.limits.dxHi)
    const dy = clampRange(rawDy, m.limits.dyLo, m.limits.dyHi)
    // The clamp can swallow the WHOLE delta (every page's union box already
    // pinned against the edge being dragged towards). Nothing would move, so the
    // gesture stays a click: flipping `moved` here would push a phantom undo step
    // and wipe the redo stack for a drag that changed nothing.
    if (!m.moved && dx === 0 && dy === 0) return true
    m.moved = true
    setAnnotations((anns) =>
      anns.map((a, i) => {
        const origin = m.origins.get(i)
        // Index match plus an id match: an array that changed under the drag (a
        // Delete keypress mid-gesture) stops the move instead of translating the
        // wrong mark.
        if (!origin || origin.id !== a.id) return a
        const p = m.limits.pages.get(origin.pageIndex)
        if (!p) return a
        return translateAnnotation(origin, dx / p.w, dy / p.h, origin.id)
      }),
    )
    return true
  }

  // The MARQUEE'S OWN pointer was cancelled (palm rejection on the pen, a
  // gesture taken over by the browser): drop the rubber band and leave the
  // selection untouched. ownsMarquee is what makes this safe in cursor mode,
  // where touchAction stays permissive: the browser fires pointercancel for
  // every touch it takes over for panning, and those must NOT destroy a pen
  // marquee. Armed only by the cursor tool, so no drawing / text / stamp gesture
  // can reach this either.
  function onOverlayPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    // A cancelled drag-move ENDS where it stands: the marks were already
    // translated live, so committing (one undo step, exactly what a normal
    // release would have pushed) leaves the result visible and undoable instead
    // of silently snapping it back mid-lesson.
    if (finishMove(e)) return
    if (!ownsMarquee(e)) return
    cancelMarquee()
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
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
      if (selectedIds.length > 0) {
        setSelectedIds(NO_SELECTION)
        return
      }
      const f = pointFraction(e.currentTarget, e.clientX, e.clientY)
      const id = nextId()
      setSelectedIds(NO_SELECTION)
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
      if (selectedIds.length > 0) {
        setSelectedIds(NO_SELECTION)
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
      setSelectedIds([id])
    } else if (cursorSelect) {
      // CURSOR = selection tool. Unreachable in read-only, where the overlay is
      // still click-through (cursorSelect is false).
      //
      // TOUCH IS DELIBERATELY UNTOUCHED: a single finger must keep SCROLLING the
      // document mid-lesson, so we bail out before any capture / preventDefault.
      if (e.pointerType === 'touch') return
      // Primary button only. A right-click gets no matching pointer-up, so arming
      // a marquee on it would leave the drag armed after the context menu.
      if (e.button !== 0) return
      // Only the bare overlay starts a selection: a press that landed on a
      // baked-in link hotspot or an open control bar belongs to that element (the
      // same guard the text / stamp branches use), so links keep working exactly
      // as before.
      if (e.target !== e.currentTarget) return
      // Interaction hygiene: commit any open text edit first (mirrors the text
      // branch above). selectBox below would also commit it, but the shift-toggle
      // and marquee paths do not go through selectBox.
      if (editingId) finishEditing(editingId)
      // Sweep up a drag-move whose pointer-up we never saw (pointer capture is
      // best-effort; if it was refused and the release landed off every overlay,
      // no handler ran). A mouse reuses the same pointerId, so leaving it armed
      // would let THIS gesture drive the previous drag's marks. Committing rather
      // than discarding keeps that move one undo step. A no-op when nothing is
      // armed, which is the normal case.
      commitMove()

      const el = e.currentTarget
      const pt = overlayPoint(el, e.clientX, e.clientY)
      const measure = measureTextBoxes(el)
      // Topmost hit wins: scan this page's marks in painting order (array order
      // within a layer, layers per layerRank) and keep the LAST one that hits.
      let hitId: string | null = null
      let hitRank = -1
      for (const a of annotations) {
        if (a.pageIndex !== pageIndex) continue
        if (!annotationHitsPoint(a, pt.x, pt.y, pt.w, pt.h, scale, measure)) continue
        const rank = layerRank(a)
        if (rank >= hitRank) {
          hitRank = rank
          hitId = a.id
        }
      }

      if (hitId !== null) {
        const id = hitId
        if (e.shiftKey) {
          // Shift+click toggles ONE mark in / out and leaves the rest alone. It
          // is a PURE toggle and never arms a drag: a toggle that also moved
          // marks would make de-selecting one of an overlapping pair impossible.
          setEditingId(null)
          setSelectedIds((prev) => {
            if (!prev.includes(id)) return [...prev, id]
            const next = prev.filter((s) => s !== id)
            return next.length === 0 ? NO_SELECTION : next
          })
          return
        }
        // Plain press on a mark. A mark that is NOT already selected becomes the
        // ONLY selection (unchanged); a mark that IS already selected keeps the
        // whole selection, so the drag below moves every selected mark together.
        // Either way the SAME gesture may continue into a drag-move -- under the
        // 4px threshold it stays exactly the click it has always been.
        const inSelection = selectedIds.includes(id)
        if (!inSelection) selectBox(id)
        // Indexed, not id-keyed (see MoveDrag.origins), and built by scanning the
        // array rather than by find(): a first-match lookup could pick a different
        // mark than the topmost one the hit test above actually chose.
        const wanted = new Set(inSelection ? selectedIds : [id])
        const origins = new Map<number, Annotation>()
        annotations.forEach((a, i) => {
          if (wanted.has(a.id)) origins.set(i, a)
        })
        const limits = moveLimits(Array.from(origins.values()), pageRects)
        // A press that could move nothing -- no mark captured, or no measured page
        // geometry to convert a px delta against -- stays a plain click. Arming a
        // drag that cannot translate anything would push a phantom undo step (and
        // wipe the redo stack) on release.
        if (origins.size === 0 || limits.pages.size === 0) return
        // Capture keeps a fast drag that leaves the overlay flowing to these
        // handlers until the pointer is released (same as the marquee arm).
        if (typeof el.setPointerCapture === 'function') {
          try {
            el.setPointerCapture(e.pointerId)
          } catch {
            // Ignore: capture is a best-effort optimisation.
          }
        }
        // Snapshot the pre-drag array now (the pendingPastRef pattern the text-box
        // drag already uses); finishMove pushes it ONLY if the drag actually
        // moved, so the whole multi-mark move is one undo step and a no-move press
        // adds nothing to history.
        pendingPastRef.current = annotationsRef.current
        moveRef.current = {
          pointerId: e.pointerId,
          clientX: e.clientX,
          clientY: e.clientY,
          origins,
          limits,
          moved: false,
        }
        return
      }

      // Empty space: arm a marquee. The selection is NOT changed yet -- a plain
      // click clears it on pointer-up, and a shift+marquee must still see the
      // current selection to add to it. Pointer capture keeps a fast drag that
      // leaves the overlay flowing here until the pointer is released.
      if (typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Ignore: capture is a best-effort optimisation.
        }
      }
      marqueeRef.current = {
        pageIndex,
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        x0: pt.x,
        y0: pt.y,
        additive: e.shiftKey,
        moved: false,
      }
    }
  }

  function onOverlayPointerMove(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (!isDrawingTool(tool)) {
      // Cursor tool: a drag-move of the selection is handled first. Only one of
      // the two can ever be armed (a press either hit a mark or landed on empty
      // space), so this is an ordering statement, not a conflict resolution.
      if (updateMove(e)) return
      // Extend an armed marquee. A no-op under every other tool.
      updateMarquee(e, pageIndex)
      return
    }
    const f = pointFraction(e.currentTarget, e.clientX, e.clientY)
    setDraft((d) => (d && d.pageIndex === pageIndex ? { pageIndex, points: [...d.points, f] } : d))
  }

  function onOverlayPointerUp(e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) {
    if (!isDrawingTool(tool)) {
      // Cursor tool: complete an armed drag-move first (see onOverlayPointerMove
      // -- the two are mutually exclusive), else an armed marquee. Both are a
      // no-op under every other tool.
      if (finishMove(e)) return
      finishMarquee(e, pageIndex)
      return
    }
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

  // --- Size resize of a text box (its right / bottom / corner handles) ------
  // Mirrors the onTextPointerDown/Move/Up flow above: best-effort pointer
  // capture, a pre-gesture snapshot in pendingPastRef pushed onto the undo stack
  // ONLY if the size actually changed (so one drag is exactly one undo step and
  // a no-move grab records nothing), and the same 3px click-vs-drag threshold.
  // The stored height is a MINIMUM, so nothing here touches the wrapping styles:
  // a box still grows past it to fit its text and can never clip a character.
  function onResizePointerDown(
    e: ReactPointerEvent<HTMLDivElement>,
    t: TextAnnotation,
    axis: 'x' | 'y' | 'both',
    startWidth: number,
    fixedHeight: number | null,
  ) {
    // Primary button only -- the same guard the cursor branch of
    // onOverlayPointerDown carries, for the same reason: a right-press gets no
    // matching pointer-up (the context menu swallows it), so arming a resize on
    // one would leave the gesture armed. Returned BEFORE stopPropagation on
    // purpose: the overlay ignores a non-primary press too, so letting this one
    // bubble changes nothing, while preventDefault here would kill the menu.
    if (e.button !== 0) return
    // stopPropagation: the grab must never reach the page overlay, where it
    // would deselect the box, arm a marquee or create a new box.
    // preventDefault: it must never blur the textarea while the box is being
    // edited (the same guard the control-bar buttons use).
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    pendingPastRef.current = annotationsRef.current
    // The height is resolved HERE rather than by the render that built this
    // handle, because for a box with no stored height it can only come from a DOM
    // measurement -- and a measurement taken during render reads the layout of
    // the PREVIOUS commit. A box whose text had just grown would then start its
    // drag from a stale, shorter height and visibly jump on the first pointer
    // move. At pointer-down the DOM is current. A box with a usable stored height
    // needs no measurement at all, and the clamp minimum is the last resort when
    // nothing is mounted to measure, so the gesture can never start from NaN.
    const startHeight = fixedHeight ?? measuredTextBoxHeight(t.id) ?? TEXT_BOX_MIN_HEIGHT
    resizeRef.current = {
      id: t.id,
      axis,
      startX: e.clientX,
      startY: e.clientY,
      // The width the box is CURRENTLY rendering at, resolved by the caller from
      // the exact value the render uses (t.width when it is a usable number,
      // else the TEXT_BOX_WIDTH fallback); the height comes from the resolve just
      // above. Single source of truth on both axes, so a legacy box -- or one
      // whose persisted size came back unusable -- always starts its resize from
      // what is on screen instead of from NaN.
      startWidth,
      startHeight,
      moved: false,
    }
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const rz = resizeRef.current
    if (!rz) return
    e.stopPropagation()
    // Self-heal a pointer-up we never saw (released outside the window, or
    // capture refused): end the gesture where it stands -- exactly as updateMove
    // does -- rather than leave it armed, which would let a later plain hover
    // over the handle keep resizing the box.
    if (e.buttons === 0) {
      onResizePointerUp(e)
      return
    }
    const dx = e.clientX - rz.startX
    const dy = e.clientY - rz.startY
    // Same 3px click-vs-drag threshold as the text / shape move drags, measured
    // on RAW pointer travel so it is independent of zoom -- and only on the axes
    // this gesture actually drives, so travel along an edge handle's own edge
    // (which changes nothing) can never arm it.
    const travel =
      rz.axis === 'x' ? Math.abs(dx) : rz.axis === 'y' ? Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy))
    if (!rz.moved && travel <= 3) return
    // The stored width / height are scale-1, so each client-px delta is divided
    // by the current scale: the edge tracks the pointer exactly at any zoom.
    const nextWidth = clampRange(rz.startWidth + dx / scale, TEXT_BOX_MIN_WIDTH, TEXT_BOX_MAX_WIDTH)
    const nextHeight = clampRange(rz.startHeight + dy / scale, TEXT_BOX_MIN_HEIGHT, TEXT_BOX_MAX_HEIGHT)
    // The clamp can swallow the WHOLE delta (the box is already at the min / max
    // and is being dragged further that way). Nothing would change, so the
    // gesture stays a grab: flipping `moved` here would push a phantom undo step
    // and wipe the redo stack for a resize that changed nothing. This is exactly
    // the guard updateMove carries, for exactly the same reason. Checked PER
    // AXIS THE GESTURE OWNS, so a corner drag pinned at max width but still
    // growing in height HAS changed something and counts as moved, while one
    // pinned at both limits has not.
    const changedWidth = rz.axis !== 'y' && nextWidth !== rz.startWidth
    const changedHeight = rz.axis !== 'x' && nextHeight !== rz.startHeight
    if (!rz.moved && !changedWidth && !changedHeight) return
    rz.moved = true
    // ONE setAnnotations even for a corner drag: two calls would turn one drag
    // step into two renders and risk two undo steps for a single gesture.
    setAnnotations((anns) =>
      anns.map((a) =>
        a.id === rz.id && a.type === 'text'
          ? {
              ...a,
              ...(rz.axis !== 'y' ? { width: nextWidth } : {}),
              ...(rz.axis !== 'x' ? { height: nextHeight } : {}),
            }
          : a,
      ),
    )
  }

  function onResizePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const rz = resizeRef.current
    if (!rz) return
    e.stopPropagation()
    resizeRef.current = null
    const el = e.currentTarget
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore.
      }
    }
    // Is the box still there? It can be removed MID-gesture (Delete while it is
    // merely selected, or Escape on an empty box being edited), which unmounts
    // its handle -- so no real pointer-up can follow and this release can only be
    // the stale-gesture self-heal above. That snapshot predates the removal, so
    // pushing it would put an OUT-OF-ORDER restore point on the stack (one undo
    // would silently resurrect the deleted box), and re-selecting a dead id below
    // would arm the Delete key on a phantom. Drop the gesture instead.
    const alive = annotationsRef.current.some((a) => a.id === rz.id)
    // A real resize pushes the pre-drag snapshot as ONE undo step; a no-move
    // grab pushes nothing. Either way the pending snapshot is cleared.
    if (rz.moved && alive) {
      const snap = pendingPastRef.current
      if (snap) {
        setPast((p) => (p.length >= HISTORY_LIMIT ? [...p.slice(1), snap] : [...p, snap]))
        setFuture([])
      }
    }
    pendingPastRef.current = null
    // The gesture ends SELECTED, like a move drag -- EXCEPT when this box is the
    // one being edited: selection and editing are mutually exclusive, so
    // selectBox would kick the teacher out of the textarea mid-sentence. Editing
    // is the stronger state and survives the resize (which is exactly what the
    // preventDefault on pointer-down protects).
    if (alive && editingId !== rz.id) selectBox(rz.id)
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
          // Flipped BELOW the box, the bar clears 20px rather than the 4px it
          // uses above: the bottom-edge and corner resize handles occupy the band
          // 2px..16px under the box edge, and at 4px the bar would sit on top of
          // them and make a near-the-page-top box impossible to resize
          // vertically. The two numbers are coupled -- handle offset 2 + handle
          // height 14 = 16 -- so this must stay clear of 16 if either changes.
          // The above-the-box branch keeps its original 4px: nothing sits there.
          ...(below ? { top: 'calc(100% + 20px)' } : { bottom: 'calc(100% + 4px)' }),
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

  // The scale-1 height a text box is CURRENTLY rendering at, measured off its
  // mounted wrapper -- the same textBoxElsRef node the cursor tool hit-tests
  // through, so this is the box's REAL rendered box and never an estimate.
  // Returns null when nothing is mounted yet or the measurement is unusable, so
  // the caller falls back to a real number rather than starting a resize from 0
  // / NaN, which would poison every clamp that follows. The DOM measures in
  // rendered px while the stored height is scale-1, hence the divide.
  function measuredTextBoxHeight(id: string): number | null {
    const el = textBoxElsRef.current.get(id)
    if (!el) return null
    const h = el.getBoundingClientRect().height / scale
    return Number.isFinite(h) && h > 0 ? h : null
  }

  // One resize handle of a text box, built for the axis it drives: the RIGHT
  // edge sets the stored (scale-1) width, the BOTTOM edge the stored MINIMUM
  // height, and the BOTTOM-RIGHT corner both at once. Each lives inside the box
  // wrapper's pointerEvents:none layer with its own pointerEvents:'auto' -- the
  // same model as the control bar -- and carries the same two guards:
  // stopPropagation so a grab never reaches the overlay (never deselects, never
  // starts a marquee or a box MOVE drag) and preventDefault on mouse/pointer
  // down so it never blurs the textarea during editing. Absolutely positioned,
  // so they stay out of flow and the wrapper's measured box (what the cursor
  // tool hit-tests) is still exactly the text box.
  function renderResizeHandle(
    t: TextAnnotation,
    axis: 'x' | 'y' | 'both',
    startWidth: number,
    fixedHeight: number | null,
  ) {
    // Placement per axis, each just OUTSIDE its own edge (the 2px margin) so a
    // hit target never covers the text or steals the box's own
    // double-click-to-edit. Hit target >= 12px on every axis; the visible grip
    // inside it is thinner.
    const placement: CSSProperties =
      axis === 'x'
        ? {
            left: '100%',
            top: '50%',
            transform: 'translateY(-50%)',
            marginLeft: 2,
            width: 14,
            height: 30,
            cursor: 'ew-resize',
          }
        : axis === 'y'
          ? {
              left: '50%',
              top: '100%',
              transform: 'translateX(-50%)',
              marginTop: 2,
              width: 30,
              height: 14,
              cursor: 'ns-resize',
            }
          : {
              left: '100%',
              top: '100%',
              marginLeft: 2,
              marginTop: 2,
              width: 14,
              height: 14,
              cursor: 'nwse-resize',
            }
    // The grip reads as the axis it drives: a tall bar for width, a wide bar for
    // height, a small square for the corner.
    const grip: CSSProperties =
      axis === 'x' ? { width: 4, height: 22 } : axis === 'y' ? { width: 22, height: 4 } : { width: 10, height: 10 }
    const label = axis === 'x' ? 'width' : axis === 'y' ? 'height' : 'size'
    return (
      <div
        onPointerDown={(e) => onResizePointerDown(e, t, axis, startWidth, fixedHeight)}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onMouseDown={(e) => e.preventDefault()}
        title={`Drag to set the text box ${label}`}
        aria-hidden
        style={{
          position: 'absolute',
          ...placement,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto',
          touchAction: 'none',
        }}
      >
        <span
          style={{
            display: 'block',
            ...grip,
            borderRadius: 2,
            backgroundColor: ORANGE,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.9)',
          }}
        />
      </div>
    )
  }

  // All three handles of one box. The start WIDTH is resolved ONCE here and
  // shared by every handle, so a corner drag can never disagree with an edge drag
  // or with what the render put on screen -- it comes from stored state, never
  // from the DOM, so there is nothing stale about it. The HEIGHT is deliberately
  // NOT resolved here: a box with no stored height can only get one by measuring
  // the DOM, and a measurement taken during render reflects the PREVIOUS commit's
  // layout, which would make the first drag after a text change jump. The stored
  // value is passed straight through and onResizePointerDown measures at grab
  // time instead. The corner is rendered LAST so that wherever it overlaps an
  // edge handle (a very short or very narrow box) it wins the pointer, which is
  // what the teacher is aiming at in that spot.
  function renderResizeHandles(t: TextAnnotation, fixedWidth: number | null, fixedHeight: number | null) {
    const startWidth = fixedWidth ?? TEXT_BOX_WIDTH
    return (
      <>
        {renderResizeHandle(t, 'x', startWidth, fixedHeight)}
        {renderResizeHandle(t, 'y', startWidth, fixedHeight)}
        {renderResizeHandle(t, 'both', startWidth, fixedHeight)}
      </>
    )
  }

  function renderTextBox(t: TextAnnotation, rect: PageRect) {
    const isEditing = t.id === editingId
    const isSelected = selectedIds.includes(t.id)
    // The control bar belongs to ONE mark, so it shows only when this box is the
    // SOLE selection (or is the box being edited). Identical to today's
    // behaviour, where only a single selection is ever reachable.
    const isSoleSelection = selectedIds.length === 1 && selectedIds[0] === t.id
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
    const bar = isEditing || isSoleSelection ? renderControlBar(t, below) : null
    // This box's stored width, or null for a box saved before the handle
    // existed. Checked as a FINITE NUMBER rather than merely `!== undefined`:
    // the value comes back from a jsonb column, and a null / NaN there would
    // otherwise render a zero-width box. Resolved ONCE here and used by all
    // three consumers below (the editor width, the static width, and the
    // handle's start width), so the gesture can never disagree with the render.
    const fixedWidth = typeof t.width === 'number' && Number.isFinite(t.width) ? t.width : null
    // This box's stored MINIMUM height, or null for a box saved before the
    // height handles existed. Checked as a FINITE NUMBER for exactly the same
    // reason as the width above: the value comes back from a jsonb column, and a
    // null / NaN there would otherwise render a zero-height box. Resolved ONCE
    // here and used by all three consumers below (the editor's minimum, the
    // static box's minimum, and the handles' start height), so the gesture can
    // never disagree with the render.
    const fixedHeight = typeof t.height === 'number' && Number.isFinite(t.height) ? t.height : null
    // Width / height / corner handles, shown under EXACTLY the same condition as
    // the control bar. In read-only nothing is selectable and nothing can be
    // edited, so they never render there (no new readOnly logic needed).
    const handles = isEditing || isSoleSelection ? renderResizeHandles(t, fixedWidth, fixedHeight) : null

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
    // Register the wrapper for cursor-tool hit testing / marquee intersection.
    // The wrapper is absolutely positioned and shrinks to fit, and the control
    // bar inside it is out of flow, so its box IS the text box's rendered box --
    // a real measurement, never an estimate. Registered in both branches below
    // and removed when the wrapper unmounts.
    const registerBox = (el: HTMLDivElement | null) => {
      if (el) textBoxElsRef.current.set(t.id, el)
      else textBoxElsRef.current.delete(t.id)
    }

    if (isEditing) {
      return (
        <div key={t.id} ref={registerBox} style={wrapperStyle}>
          <EditableTextBox
            value={t.text}
            widthPx={(fixedWidth ?? TEXT_BOX_WIDTH) * scale}
            // 0 for a box with no stored height, so Math.max in the auto-grow
            // effect is a true no-op and the box keeps the exact content-driven
            // height it has always had.
            minHeightPx={(fixedHeight ?? 0) * scale}
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
          {handles}
        </div>
      )
    }

    return (
      <div key={t.id} ref={registerBox} style={wrapperStyle}>
        <div
          onPointerDown={(e) => onTextPointerDown(e, t, rect)}
          onPointerMove={onTextPointerMove}
          onPointerUp={onTextPointerUp}
          onDoubleClick={() => enterEdit(t.id)}
          style={{
            ...baseStyle,
            display: 'inline-block',
            verticalAlign: 'top',
            // A box that has been shaped by its handle HOLDS that shape: a fixed
            // width, so short text keeps the box the teacher drew. A box with no
            // stored width keeps the exact maxWidth it has always had, so every
            // already-saved annotation renders pixel-identical.
            ...(fixedWidth !== null
              ? { width: fixedWidth * scale }
              : { maxWidth: TEXT_BOX_WIDTH * scale }),
            // Same rule on the vertical axis, but as a MINIMUM: the box holds
            // the height the teacher drew, and text longer than that still grows
            // it (nothing clips). A box with no stored height adds no property at
            // all, so every already-saved annotation renders pixel-identical.
            ...(fixedHeight !== null ? { minHeight: fixedHeight * scale } : {}),
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
        {handles}
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
    // Same rule as the text box: the A- / A+ / delete bar belongs to ONE stamp,
    // so it renders only when this stamp is the SOLE selection. (The selection
    // FRAME, drawn in the page svg, still shows on every selected stamp.)
    const isSoleSelection = selectedIds.length === 1 && selectedIds[0] === s.id
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
        {isSoleSelection ? renderShapeControlBar(s, below) : null}
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
    // Strokes and arrows have no DOM node of their own, so their selection
    // outline is drawn in this page's svg, from the same pixel bounding box the
    // marquee intersects. Text boxes (their own orange outline) and stamps
    // (their own selection frame) are unchanged.
    const outlinedMarks = [...pageStrokes, ...pageArrows].filter((a) => selectedIds.includes(a.id))

    return (
      <div
        key={pageIndex}
        onPointerDown={(e) => onOverlayPointerDown(e, pageIndex)}
        onPointerMove={(e) => onOverlayPointerMove(e, pageIndex)}
        onPointerUp={(e) => onOverlayPointerUp(e, pageIndex)}
        onPointerCancel={onOverlayPointerCancel}
        style={{
          position: 'absolute',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          // Click-through in READ-ONLY cursor mode, so scroll / zoom work exactly
          // as they always have. In an editable viewer the cursor tool is a real
          // selection tool, so the overlay must receive mouse / pen events; touch
          // still scrolls the document because touchAction stays permissive below
          // and every cursor-tool handler rejects pointerType 'touch' (the down
          // branch returns before any capture, and ownsMarquee rejects it on
          // move / up / cancel). No wheel handler is attached anywhere, so wheel
          // scrolling passes straight through to the scroll container.
          pointerEvents: tool === 'cursor' && !cursorSelect ? 'none' : 'auto',
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
            const isSelected = selectedIds.includes(s.id)
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
          {/* Selection outline for a selected stroke / arrow: a dashed orange
              bounding box, drawn after the marks so a highlighter can never sit
              on top of it. Same accent and 3px offset as the stamp's selection
              frame; dashed so it reads as a selection, not as a drawn mark. */}
          {outlinedMarks.map((a) => {
            const b = annotationBounds(a, rect.width, rect.height, scale, NO_TEXT_MEASURE)
            if (!b) return null
            return (
              <rect
                key={`sel-${a.id}`}
                x={round1(b.left - 3)}
                y={round1(b.top - 3)}
                width={round1(b.right - b.left + 6)}
                height={round1(b.bottom - b.top + 6)}
                rx={3}
                fill="none"
                stroke={ORANGE}
                strokeWidth={1}
                strokeDasharray="4 3"
              />
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
          {/* Marquee (rubber band), drawn last so it sits above every mark. Lives
              only on the page the drag started on. */}
          {marquee && marquee.pageIndex === pageIndex ? (
            <rect
              x={round1(Math.min(marquee.x0, marquee.x1))}
              y={round1(Math.min(marquee.y0, marquee.y1))}
              width={round1(Math.abs(marquee.x1 - marquee.x0))}
              height={round1(Math.abs(marquee.y1 - marquee.y0))}
              fill="rgba(255, 131, 3, 0.10)"
              stroke={ORANGE}
              strokeWidth={1}
              strokeDasharray="4 3"
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
          onMouseEnter={() => setHoverKey('zoomOut')}
          onMouseLeave={() => setHoverKey((k) => (k === 'zoomOut' ? null : k))}
          style={{ ...iconButtonStyle(canZoomOut), ...hoverFilterStyle(hoverKey === 'zoomOut', canZoomOut) }}
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
          onMouseEnter={() => setHoverKey('zoomIn')}
          onMouseLeave={() => setHoverKey((k) => (k === 'zoomIn' ? null : k))}
          style={{ ...iconButtonStyle(canZoomIn), ...hoverFilterStyle(hoverKey === 'zoomIn', canZoomIn) }}
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
          onMouseEnter={() => setHoverKey('fitWidth')}
          onMouseLeave={() => setHoverKey((k) => (k === 'fitWidth' ? null : k))}
          style={{ ...toggleButtonStyle(fitMode, !isReady), ...hoverFilterStyle(hoverKey === 'fitWidth', isReady) }}
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
          onMouseEnter={() => setHoverKey('prevPage')}
          onMouseLeave={() => setHoverKey((k) => (k === 'prevPage' ? null : k))}
          style={{ ...iconButtonStyle(canPrev), ...hoverFilterStyle(hoverKey === 'prevPage', canPrev) }}
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
          onMouseEnter={() => setHoverKey('nextPage')}
          onMouseLeave={() => setHoverKey((k) => (k === 'nextPage' ? null : k))}
          style={{ ...iconButtonStyle(canNext), ...hoverFilterStyle(hoverKey === 'nextPage', canNext) }}
        >
          <ChevronRight size={16} />
        </button>

        {/* Annotation, colour and undo/redo/clear controls are hidden entirely
            in read-only mode; zoom, fit, page nav and fullscreen stay visible. */}
        {!readOnly && (
          <>
        <span style={dividerStyle} aria-hidden />

        {/* Annotation tools: Cursor / Draw / Highlight / Underline / Arrow / Text as
            ONE segmented, icon-only pill group. Each segment is UNCHANGED -- same
            selectTool handler, toolButtonStyle active styling, aria-pressed, tooltip
            and hoverFilterStyle; only the wrapping <div> is new. The star/tick/cross
            stamps and the colour swatch strip below stay exactly as they are -- they
            become the Shapes dropdown and the colour dot in separate later pieces. */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 3,
            borderRadius: 10,
            border: '1px solid #e5e7eb',
            backgroundColor: '#f9fafb',
            flexShrink: 0,
          }}
        >
        <button
          type="button"
          onClick={() => selectTool('cursor')}
          disabled={!isReady}
          aria-pressed={tool === 'cursor'}
          aria-label="Select / scroll"
          title="Select / scroll"
          onMouseEnter={() => setHoverKey('cursor')}
          onMouseLeave={() => setHoverKey((k) => (k === 'cursor' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'cursor', !isReady), ...hoverFilterStyle(hoverKey === 'cursor', isReady) }}
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
          onMouseEnter={() => setHoverKey('pen')}
          onMouseLeave={() => setHoverKey((k) => (k === 'pen' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'pen', !isReady), ...hoverFilterStyle(hoverKey === 'pen', isReady) }}
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
          onMouseEnter={() => setHoverKey('highlighter')}
          onMouseLeave={() => setHoverKey((k) => (k === 'highlighter' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'highlighter', !isReady), ...hoverFilterStyle(hoverKey === 'highlighter', isReady) }}
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
          onMouseEnter={() => setHoverKey('underline')}
          onMouseLeave={() => setHoverKey((k) => (k === 'underline' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'underline', !isReady), ...hoverFilterStyle(hoverKey === 'underline', isReady) }}
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
          onMouseEnter={() => setHoverKey('arrow')}
          onMouseLeave={() => setHoverKey((k) => (k === 'arrow' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'arrow', !isReady), ...hoverFilterStyle(hoverKey === 'arrow', isReady) }}
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
          onMouseEnter={() => setHoverKey('text')}
          onMouseLeave={() => setHoverKey((k) => (k === 'text' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'text', !isReady), ...hoverFilterStyle(hoverKey === 'text', isReady) }}
        >
          <Type size={16} />
        </button>
        </div>
        <button
          type="button"
          onClick={() => selectStamp('star')}
          disabled={!isReady}
          aria-pressed={tool === 'stamp' && stampKind === 'star'}
          aria-label="Star stamp"
          title="Star stamp"
          onMouseEnter={() => setHoverKey('stampStar')}
          onMouseLeave={() => setHoverKey((k) => (k === 'stampStar' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'stamp' && stampKind === 'star', !isReady), ...hoverFilterStyle(hoverKey === 'stampStar', isReady) }}
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
          onMouseEnter={() => setHoverKey('stampTick')}
          onMouseLeave={() => setHoverKey((k) => (k === 'stampTick' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'stamp' && stampKind === 'tick', !isReady), ...hoverFilterStyle(hoverKey === 'stampTick', isReady) }}
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
          onMouseEnter={() => setHoverKey('stampCross')}
          onMouseLeave={() => setHoverKey((k) => (k === 'stampCross' ? null : k))}
          style={{ ...toolButtonStyle(tool === 'stamp' && stampKind === 'cross', !isReady), ...hoverFilterStyle(hoverKey === 'stampCross', isReady) }}
        >
          <X size={16} />
        </button>

        <span style={dividerStyle} aria-hidden />

        {/* Colour: the 8-swatch palette folded behind ONE round colour-dot
            trigger. The dot is filled with the current colour and uses the swatch
            styling (swatchStyle) so it sits alongside the tool / stamp controls.
            CRITICAL: the dot -- exactly like every swatch -- preventDefaults its
            mouse AND pointer down; without it, opening the popover while a text
            box is mid-edit would blur the textarea, drop editingId, and silently
            break the recolour-the-editing-mark path. The popover stays open across
            picks (so a mark can be tried against several colours in a row) and
            closes only on Escape, an outside pointer-down, or clicking the dot
            again. The 8 swatch buttons inside are UNCHANGED from the old strip. */}
        <div ref={colorMenuRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setColorOpen((o) => !o)}
            disabled={!isReady}
            aria-haspopup="true"
            aria-expanded={colorOpen}
            aria-label="Colour"
            title="Colour"
            onMouseEnter={() => setHoverKey('colorDot')}
            onMouseLeave={() => setHoverKey((k) => (k === 'colorDot' ? null : k))}
            style={{ ...swatchStyle(color, colorOpen, !isReady), ...hoverFilterStyle(hoverKey === 'colorDot', isReady) }}
          />
          {colorOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 20,
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 26px)',
                gap: 6,
                padding: 8,
                backgroundColor: '#ffffff',
                border: '1px solid #d1d5db',
                borderRadius: 8,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              }}
            >
              {COLOR_SWATCHES.map((sw) => (
                <button
                  key={sw.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHoverKey(sw.value)}
                  onMouseLeave={() => setHoverKey((k) => (k === sw.value ? null : k))}
                  onClick={() => {
                    setColor(sw.value)
                    // If a mark is being EDITED, recolour that one (any type, undoable).
                    // Otherwise recolour EVERY selected mark, as ONE history entry and
                    // ONE setAnnotations so the whole recolour is a single undo step.
                    // Either way only marks whose colour actually DIFFERS are touched,
                    // and history is snapshotted only when at least one will change --
                    // so re-picking the current colour stays a true no-op (no phantom
                    // undo step). editingId and selectedIds are mutually exclusive, so
                    // this if/else reproduces the old `editingId ?? selectedId` target.
                    if (editingId) {
                      const current = annotationsRef.current.find((a) => a.id === editingId)
                      if (current && current.color !== sw.value) {
                        recordHistory()
                        setAnnotations((anns) =>
                          anns.map((a) => (a.id === editingId ? { ...a, color: sw.value } : a)),
                        )
                      }
                    } else if (selectedIds.length > 0) {
                      const targets = new Set(
                        annotationsRef.current
                          .filter((a) => selectedIds.includes(a.id) && a.color !== sw.value)
                          .map((a) => a.id),
                      )
                      if (targets.size > 0) {
                        recordHistory()
                        setAnnotations((anns) =>
                          anns.map((a) => (targets.has(a.id) ? { ...a, color: sw.value } : a)),
                        )
                      }
                    }
                  }}
                  disabled={!isReady}
                  aria-pressed={color === sw.value}
                  aria-label={sw.label}
                  title={sw.label}
                  style={{
                    ...swatchStyle(sw.value, color === sw.value, !isReady),
                    ...hoverFilterStyle(hoverKey === sw.value, isReady),
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <span style={dividerStyle} aria-hidden />

        {/* Undo / Redo / Clear */}
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo last annotation"
          title="Undo"
          onMouseEnter={() => setHoverKey('undo')}
          onMouseLeave={() => setHoverKey((k) => (k === 'undo' ? null : k))}
          style={{ ...iconButtonStyle(canUndo), ...hoverFilterStyle(hoverKey === 'undo', canUndo) }}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo last annotation"
          title="Redo"
          onMouseEnter={() => setHoverKey('redo')}
          onMouseLeave={() => setHoverKey((k) => (k === 'redo' ? null : k))}
          style={{ ...iconButtonStyle(canRedo), ...hoverFilterStyle(hoverKey === 'redo', canRedo) }}
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
          onMouseEnter={() => setHoverKey('clear')}
          onMouseLeave={() => setHoverKey((k) => (k === 'clear' ? null : k))}
          style={{ ...iconButtonStyle(canClear), ...hoverFilterStyle(hoverKey === 'clear', canClear) }}
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
          onMouseEnter={() => setHoverKey('fullscreen')}
          onMouseLeave={() => setHoverKey((k) => (k === 'fullscreen' ? null : k))}
          style={{
            ...toggleButtonStyle(isFullscreen, !isReady),
            ...hoverFilterStyle(hoverKey === 'fullscreen', isReady),
            marginLeft: 'auto',
          }}
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

// Subtle hover tint layered on top of a button's base style. Returns {} when disabled
// or not the hovered control, so disabled buttons never react to hover and every
// button is byte-for-byte unaffected by this function existing. `filter` is a property
// none of the four style helpers above ever set, so spreading this before or after
// them can never clobber a value they own.
function hoverFilterStyle(hovered: boolean, enabled: boolean): CSSProperties {
  return hovered && enabled ? { filter: 'brightness(0.94)' } : {}
}
