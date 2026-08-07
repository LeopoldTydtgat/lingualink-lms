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

// Live in-class "time remaining" timer shared by the teacher RightPanel and the
// student StudentRightPanel ("In class: 47:37 remaining").
//
// Deliberately NOT formatCountdown (each panel's local pre-class hero formatter):
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
