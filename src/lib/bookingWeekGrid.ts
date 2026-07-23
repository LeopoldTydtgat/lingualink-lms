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
export interface GridStartSlot {
  startIso: string
  bookable: boolean
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

// Re-exported so grid consumers can share the row/step granularity constant
// instead of hard-coding 30 again.
export { SLOT_MINUTES, SLOT_MS }
