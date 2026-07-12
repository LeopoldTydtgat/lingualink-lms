// NEW324: bookable-start check for the student booking grid.
//
// Since NEW317 the availability API buckets each 30-minute slot under the
// student-local date of its own start instant, so a 60/90-minute run that
// crosses student-local midnight has its continuation slots in the NEXT
// day's column. Any check that walks forward within one day column can
// therefore never assemble such a run. This helper is pure instant math:
// a start is bookable iff every 30-minute step of the run is present in
// the week-wide set of available slot start instants. A missing instant
// means a gap or an unavailable slot — fail closed. No date/column logic.
export function isBookableStart(
  startIso: string,
  slotsNeeded: number,
  availableStartMs: Set<number>,
): boolean {
  const startMs = new Date(startIso).getTime()
  for (let i = 0; i < slotsNeeded; i++) {
    if (!availableStartMs.has(startMs + i * 30 * 60 * 1000)) return false
  }
  return true
}
