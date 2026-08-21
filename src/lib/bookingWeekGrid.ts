// BOOK-1 Stage A: pure helpers for the single-page student booking week grid.
//
// The availability API (api/student/availability) returns 30-min slots keyed
// by the student-local date of each slot's OWN start instant, and — NEW324 —
// deliberately includes "day-8" extras: continuation instants up to 60 min
// past the requested week window, keyed under a date OUTSIDE the 7 requested
// columns, so a 60/90-min run starting late on the week's last day can still
// validate. Consumers must therefore NEVER derive their columns from the
// response keys (that would paint a phantom 8th column). Columns come from
// getWeekColumnKeys; the response is read whole exactly once — to build the
// week-wide instant set — and otherwise only per known column key.
//
// Everything here is pure instant/calendar math: no React, no fetch, no
// "now". Past and within-24h slots arrive already blocked (available: false)
// from the slot engine, so this module needs no clock.

import { addDaysToDateKey, utcInstantToTzParts } from '@/lib/utils/timezone'
import { isBookableStart } from '@/lib/bookingGrid'

const SLOT_MINUTES = 30
const SLOT_MS = SLOT_MINUTES * 60 * 1000

// One 30-min slot as served by the availability API.
export interface ApiSlot {
  startIso: string // UTC ISO string
  available: boolean
}

// The `slots` field of the availability API response, verbatim: day arrays
// keyed by YYYY-MM-DD in the student timezone — 7 requested dates plus,
// legitimately, a day-8 key for NEW324 extended continuation slots.
export type SlotsResponse = Record<string, ApiSlot[]>

// A slot placed in a grid column. `bookable` is start-validity for the CHOSEN
// duration, not raw availability: true iff a lesson of that duration can
// start here (every 30-min step of the run is available, week-wide). False
// slots still render — as grey cells — so the grid shape stays stable.
//
// `available` is the RAW ApiSlot.available flag carried through unchanged, so
// consumers can tell the two reasons a cell is non-bookable apart: a slot
// that is itself blocked/booked (available: false) versus one that is free
// but cannot host the chosen duration because its run runs out (available:
// true, bookable: false). The latter is exactly the cell a tap should snap
// backwards from — see snapToValidStart. Never conflate the two flags.
export interface GridStartSlot {
  startIso: string
  bookable: boolean
  available: boolean
}

/**
 * The 7 YYYY-MM-DD column keys of the visible week: pure calendar arithmetic
 * on weekStartKey via addDaysToDateKey. weekStartKey is already a date key in
 * the student's timezone (the same key sent to the API as weekStart), so no
 * timezone parameter is needed — day arithmetic on a bare date key is
 * tz-independent by construction.
 *
 * This is the ONLY legitimate source of grid columns. Never derive columns
 * from Object.keys(slotsResponse): the response carries a day-8 key (NEW324)
 * that must never become a column.
 */
export function getWeekColumnKeys(weekStartKey: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(weekStartKey, i))
}

/**
 * Week-wide set of AVAILABLE slot start instants (epoch ms) across ALL
 * response keys — including the day-8 extras, which exist precisely so that
 * a 60/90-min run starting late on the last column can validate its
 * continuation steps. Unavailable slots are never added: isBookableStart
 * treats a missing instant as a gap and fails closed.
 */
export function buildInstantSet(slotsResponse: SlotsResponse): Set<number> {
  const instantSet = new Set<number>()
  for (const daySlots of Object.values(slotsResponse)) {
    for (const slot of daySlots) {
      if (slot.available) instantSet.add(new Date(slot.startIso).getTime())
    }
  }
  return instantSet
}

/**
 * The grid's cell data: for each of the 7 column keys, every slot the API
 * returned for that date, flagged with start-validity for the chosen
 * duration (isBookableStart against the week-wide instant set, so runs
 * crossing student-local midnight — whose continuation slots sit in the NEXT
 * column or under the day-8 key — still validate for their start column).
 * Non-bookable slots are kept, flagged false, so the UI can render grey
 * cells. Columns the response has no slots for come back as empty arrays.
 * The raw `available` flag rides along untouched next to the derived
 * `bookable` one; the bookable computation reads only the instant set.
 *
 * The returned record preserves columnKeys order (string date keys are never
 * array-index-like, so object insertion order is guaranteed) — downstream
 * consumers may rely on chronological iteration.
 */
export function getValidStartsByColumn(
  columnKeys: string[],
  slotsResponse: SlotsResponse,
  instantSet: Set<number>,
  durationMinutes: number,
): Record<string, GridStartSlot[]> {
  const slotsNeeded = durationMinutes / SLOT_MINUTES
  const byColumn: Record<string, GridStartSlot[]> = {}
  for (const key of columnKeys) {
    byColumn[key] = (slotsResponse[key] ?? []).map((slot) => ({
      startIso: slot.startIso,
      bookable: isBookableStart(slot.startIso, slotsNeeded, instantSet),
      available: slot.available,
    }))
  }
  return byColumn
}

/**
 * The grid's visible time rows, collapsed into contiguous bands.
 *
 * A row is a 30-min wall-clock line identified by minutes since student-local
 * midnight (540 = 09:00). Rows are wall-clock, NOT instants: on a
 * DST-transition week the same 09:00 row maps to different UTC instants on
 * different columns, and keying rows by instant would split one visual row in
 * two. utcInstantToTzParts pins the wall clock to the student timezone —
 * Date.getHours() is browser-local and wrong for a student elsewhere.
 *
 * A row exists iff at least one column has a BOOKABLE start at that wall
 * time, OR that wall time is a 30-min step inside some bookable run: every
 * bookable start contributes the wall-clock rows of all durationMinutes / 30
 * steps of its run (each step instant is start epoch-ms + k * SLOT_MS,
 * converted back to the student wall clock via utcInstantToTzParts — never
 * Date getters or ISO-string math). Without the continuation rows, wall times
 * that are valid inside a run but a valid START nowhere in the week were
 * collapsed away, and a selected run's highlight was swallowed by the gap
 * band. Rows that neither host a bookable start nor continue any bookable
 * run are collapsed away with the empty ones. Rows 30 minutes apart are
 * contiguous and share a band; each gap starts a new band, so the UI can
 * render a gap marker between bands. Bands are sorted ascending by minutes —
 * early-morning continuation rows (e.g. 00:00 after a cross-midnight run)
 * sort first, matching a top-down time axis; midnight adjacency (23:30 →
 * 00:00) is deliberately NOT treated as contiguous, since grid rows are a
 * single day's vertical axis.
 */
export function collapseEmptyBands(
  validStartsByColumn: Record<string, GridStartSlot[]>,
  studentTimezone: string,
  durationMinutes: number,
): number[][] {
  const slotsNeeded = durationMinutes / SLOT_MINUTES
  const rowMinutes = new Set<number>()
  for (const columnSlots of Object.values(validStartsByColumn)) {
    for (const slot of columnSlots) {
      if (!slot.bookable) continue
      const startMs = new Date(slot.startIso).getTime()
      for (let step = 0; step < slotsNeeded; step++) {
        const parts = utcInstantToTzParts(new Date(startMs + step * SLOT_MS), studentTimezone)
        rowMinutes.add(parts.hour * 60 + parts.minute)
      }
    }
  }

  const sorted = [...rowMinutes].sort((a, b) => a - b)
  const bands: number[][] = []
  for (const minutes of sorted) {
    const currentBand = bands[bands.length - 1]
    if (currentBand && minutes - currentBand[currentBand.length - 1] === SLOT_MINUTES) {
      currentBand.push(minutes)
    } else {
      bands.push([minutes])
    }
  }
  return bands
}

/**
 * Column keys with at least one bookable start this week — days with nothing
 * bookable (for the chosen duration) are hidden entirely. Order follows the
 * input record's key order, i.e. the chronological columnKeys order that
 * getValidStartsByColumn preserved.
 */
export function getVisibleColumns(
  validStartsByColumn: Record<string, GridStartSlot[]>,
): string[] {
  return Object.keys(validStartsByColumn).filter((key) =>
    validStartsByColumn[key].some((slot) => slot.bookable),
  )
}

/**
 * The grid's UNCOLLAPSED time axis: the ascending row keys the grid renders,
 * spanning the earliest wall-clock row any slot occupies to the latest, with
 * the gap rows in between included.
 *
 * Where collapseEmptyBands answers "which rows are worth showing for THIS
 * duration" (bookable starts and their run steps only, split into bands),
 * this answers "how tall is the day" — so a grid can render a stable axis
 * that does not resize as the student flips between 30/60/90 min. EVERY slot
 * in the record contributes its row, available or not: the blocked cells are
 * exactly the grey background the axis has to make room for, and dropping
 * them would shrink the axis around whichever slots happen to be free today.
 *
 * THE AXIS IS A UNION, NOT JUST A RULER. The 30-minute ruler is stepped from
 * the earliest key, but the result unions that ruler with every key actually
 * collected. A key not congruent to the ruler — a slot at wall 09:17, row
 * 557 — therefore gets its OWN row instead of being stepped straight over,
 * so no slot can be dropped from the axis. Stepping alone is not enough:
 * slot instants are 30-min aligned only as far as the DATA is, and neither
 * the availability schema nor the slot engine guarantees that. An override
 * stored at :17 past mints :17/:47 slots beside the :00/:30 general ones,
 * and a teacher editing their timezone across a residue boundary leaves
 * stale overrides on one residue while fresh general rows land on another —
 * either way two residues share one week. buildCellMaps keys its cells by
 * the identical wall-minute value (utcInstantToTzParts, hour * 60 + minute),
 * so every cell key it can produce is in this axis by construction: the two
 * cannot disagree about which rows exist, and no cell is left without a row
 * to render on.
 *
 * Rows are wall-clock, keyed via utcInstantToTzParts in the student
 * timezone — never Date getters (browser-local, wrong for a student
 * elsewhere) and never ISO-string slicing (UTC, wrong for everyone not on
 * UTC). A DST fall-back day, where one wall hour occurs twice at two distinct
 * UTC instants, therefore yields ONE row key, not two: the axis is a visual
 * day's vertical ruler, and a duplicated hour must not stretch it. The
 * spring-forward hour that does not exist never appears as any slot's row
 * key, but IS still emitted as a gap row when it sits between two real rows —
 * the axis is continuous by definition, the cell maps have nothing to put
 * there, and it renders as empty background like any other gap row.
 *
 * Empty input — or a record whose columns are all empty arrays — yields [].
 */
export function buildRowAxis(
  validStartsByColumn: Record<string, GridStartSlot[]>,
  studentTimezone: string,
): number[] {
  const rowMinutes = new Set<number>()
  for (const columnSlots of Object.values(validStartsByColumn)) {
    for (const slot of columnSlots) {
      const parts = utcInstantToTzParts(slot.startIso, studentTimezone)
      rowMinutes.add(parts.hour * 60 + parts.minute)
    }
  }
  if (rowMinutes.size === 0) return []

  let min = Infinity
  let max = -Infinity
  for (const minutes of rowMinutes) {
    if (minutes < min) min = minutes
    if (minutes > max) max = minutes
  }

  // Seeded with the real keys, then the ruler is added on top — a Set, so an
  // off-residue key and a stepped row can never collide into a duplicate.
  const axis = new Set(rowMinutes)
  for (let minutes = min; minutes <= max; minutes += SLOT_MINUTES) axis.add(minutes)
  return [...axis].sort((a, b) => a - b)
}

/**
 * The grid body's per-column cell lookup: for each column key, a map from
 * student-local wall minutes (hour * 60 + minute — the same keying
 * collapseEmptyBands uses for rows) to the slot that renders on that row. A
 * column with no slots yields an empty map, so every row renders grey there.
 *
 * DST FALL-BACK RULE (CAL2). On a fall-back day one wall-clock hour occurs
 * TWICE, so two distinct UTC instants legitimately claim the same row key —
 * e.g. in America/New_York on 2026-11-01 the wall time 01:00 is both
 * 05:00:00Z (EDT, UTC-4) and 06:00:00Z (EST, UTC-5). The EARLIER instant wins
 * the cell, decided by an explicit `new Date(startIso).getTime()` comparison:
 * never by input order, and never by last-write-wins, which silently dropped
 * the earlier instant out of the grid so it could never be booked. Keeping
 * the earlier instant matches the 'first occurrence' disambiguation
 * wallTimeToUtcMs applies to an ambiguous wall time (lib/utils/timezone.ts),
 * so a duplicated wall hour resolves to the same instant here as it does
 * everywhere else in the app. The later instant is simply not offered:
 * rendering both — duplicate rows or a split cell — is a rejected design.
 *
 * Spring-forward needs no handling: the skipped wall hour does not exist in
 * the timezone, so utcInstantToTzParts never reports those row keys for any
 * instant and no slot can collide there.
 */
export function buildCellMaps(
  columnKeys: string[],
  validStartsByColumn: Record<string, GridStartSlot[]>,
  studentTimezone: string,
): Map<string, Map<number, GridStartSlot>> {
  const cellMaps = new Map<string, Map<number, GridStartSlot>>()
  for (const key of columnKeys) {
    const m = new Map<number, GridStartSlot>()
    for (const slot of validStartsByColumn[key]) {
      const parts = utcInstantToTzParts(slot.startIso, studentTimezone)
      const rowKey = parts.hour * 60 + parts.minute
      const existing = m.get(rowKey)
      // Explicit epoch-ms comparison — order-independent by construction.
      if (
        existing === undefined ||
        new Date(slot.startIso).getTime() < new Date(existing.startIso).getTime()
      ) {
        m.set(rowKey, slot)
      }
    }
    cellMaps.set(key, m)
  }
  return cellMaps
}

/**
 * Resolve the slot a student TAPPED into the start instant of the run that
 * should actually be booked: the LATEST valid start whose run of slotsNeeded
 * 30-min steps covers the tapped slot, or null if no such start exists.
 *
 * Why walk backwards at all: at 60/90 min the last slots of an availability
 * band are free (available: true) but are not valid starts — their run would
 * run off the end of the band, so isBookableStart fails them. Tapping one
 * used to do nothing. Snapping instead books the run that ENDS on the tapped
 * slot, which is what "I want a lesson around then" means when the tail of
 * the band is what is free.
 *
 * Pure instant math: candidates are tappedMs - k * SLOT_MS for k = 0 …
 * slotsNeeded - 1, each validated by isBookableStart against the same
 * week-wide available-instant set the grid was built from. No wall clock, no
 * date keys, no columns — so a run crossing student-local midnight (its
 * earlier steps live in the PREVIOUS column, or the tapped slot is itself a
 * day-8 continuation) resolves exactly like any other. DST needs no handling
 * for the same reason: 30 minutes of elapsed time is 30 minutes of elapsed
 * time across any offset change, and a candidate instant is either in the set
 * or it is not.
 *
 * k ascends from 0, so the FIRST hit is the LATEST covering start. That is
 * deliberate: it is the start closest to what the student pointed at, and it
 * keeps a tap on an already-valid start returning that same slot unchanged.
 * Fails closed — a tapped slot no valid start covers returns null, and the
 * caller must not book.
 */
export function snapToValidStart(
  tappedIso: string,
  slotsNeeded: number,
  availableStartMs: Set<number>,
): string | null {
  const tappedMs = new Date(tappedIso).getTime()
  for (let k = 0; k < slotsNeeded; k++) {
    const candidateIso = new Date(tappedMs - k * SLOT_MS).toISOString()
    if (isBookableStart(candidateIso, slotsNeeded, availableStartMs)) return candidateIso
  }
  return null
}

// Re-exported so grid consumers can share the row/step granularity constant
// instead of hard-coding 30 again.
export { SLOT_MINUTES, SLOT_MS }
