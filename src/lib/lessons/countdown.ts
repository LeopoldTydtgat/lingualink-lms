// Compound-duration countdown formatter ("2d 5h 30m" / "10h 18m 36s") shared by the
// teacher upcoming-classes list and the student my-classes list + hero card.
export function formatCompoundCountdown(secondsUntil: number): string {
  if (secondsUntil <= 0) return 'Starting now'
  const days = Math.floor(secondsUntil / 86400)
  const hours = Math.floor((secondsUntil % 86400) / 3600)
  const minutes = Math.floor((secondsUntil % 3600) / 60)
  const seconds = Math.floor(secondsUntil % 60)
  if (days > 0) {
    return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

// Pre-class hero countdown for the teacher RightPanel and the student
// StudentRightPanel - the 22px zero-padded HH:MM:SS block above the class time.
// It was duplicated verbatim in both panels. The two panels remain separate
// components by design; this is only the formatter they share.
//
// Deliberately a different shape from the other two formatters here: it always
// emits an hour block under a day and zero-pads it ("00:47:37"), where
// formatRemainingCountdown drops the hour block entirely under an hour and never
// pads it, and formatCompoundCountdown uses the "10h 18m 36s" compound form.
// It also floors at 'Now', not 'Starting now'.
export function formatHeroCountdown(secondsUntil: number): string {
  if (secondsUntil <= 0) return 'Now'
  const days = Math.floor(secondsUntil / 86400)
  const hours = Math.floor((secondsUntil % 86400) / 3600)
  const minutes = Math.floor((secondsUntil % 3600) / 60)
  const seconds = secondsUntil % 60
  if (days > 0) {
    return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Live in-class "time remaining" timer shared by the teacher RightPanel and the
// student StudentRightPanel ("In class: 47:37 remaining").
//
// Deliberately NOT formatHeroCountdown (the panels' pre-class hero formatter above):
// that one always emits a zero-padded HH:MM:SS block and is still the hero's
// format. This one drops the hour block entirely under an hour and does not
// zero-pad the hour above it, so a mid-class timer reads 47:37 rather than
// 00:47:37. Minutes and seconds are always two digits.
export function formatRemainingCountdown(secondsRemaining: number): string {
  const total = Math.max(0, Math.floor(secondsRemaining))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

// What a lesson card should say about a lesson RIGHT NOW - the single source of truth for
// the countdown label, its value, and whether the class is live, shared by the teacher
// upcoming-classes list and the student my-classes list + hero. Both portals keep an
// in-progress class in their list until it ENDS, so "time until start" alone is wrong the
// moment a class begins: a class 40 minutes underway must read "In class 47:37", never
// "Starting now" under a NEXT pill.
export type LessonCountdown = {
  live: boolean
  label: string
  value: string
}

// PURE EPOCH-MS ARITHMETIC. Every argument is an absolute instant in milliseconds and the
// only operation performed on them is subtraction. No Date is constructed from local
// parts, no timezone is read, no toISOString(): the result is byte-identical in every
// timezone, and the caller owns resolving its own instants.
export function describeLessonCountdown(
  startMs: number,
  endMs: number,
  nowMs: number
): LessonCountdown {
  // Teaching window is half-open [start, end): the start instant is already live and the
  // end instant is not, matching pickLiveLesson's teaching-time test in liveLesson.ts.
  if (nowMs >= startMs && nowMs < endMs) {
    return {
      live: true,
      label: 'In class',
      value: formatRemainingCountdown(Math.floor((endMs - nowMs) / 1000)),
    }
  }
  // Not live: before the class it counts down to the start; at or past the end it
  // collapses to zero rather than counting up, so a row that outlives its class by a
  // render tick degrades to "Starting now" instead of a negative timer.
  return {
    live: false,
    label: 'Starts in',
    value: formatCompoundCountdown(nowMs >= endMs ? 0 : Math.floor((startMs - nowMs) / 1000)),
  }
}
