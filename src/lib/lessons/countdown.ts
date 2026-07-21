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
