// Streak computation shared by the my-classes stat card and the right-panel
// streak banner. Consecutive weeks (Mon–Sun) with >=1 completed lesson, in the
// given timezone. en-CA gives YYYY-MM-DD in tz; Date.UTC is used purely for
// calendar-day arithmetic on an already-localised date — no timezone drift, no
// toISOString for local dates.

export function computeStreakWeeks(
  completedScheduledAts: string[], // lessons.scheduled_at ISO strings, status='completed'
  timezone: string,
  now: Date = new Date()
): number {
  const localDateKey = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  const mondayKey = (dateKey: string) => {
    const [y, m, d] = dateKey.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    const dow = dt.getUTCDay() // 0=Sun..6=Sat
    dt.setUTCDate(dt.getUTCDate() - (dow === 0 ? 6 : dow - 1))
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  }
  const shiftWeeks = (mKey: string, weeks: number) => {
    const [y, m, d] = mKey.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() + weeks * 7)
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  }

  const weekSet = new Set(
    completedScheduledAts.map((s) => mondayKey(localDateKey(new Date(s))))
  )
  const currentMonday = mondayKey(localDateKey(now))
  let streakWeeks = 0
  let cursor: string | null = null
  if (weekSet.has(currentMonday)) cursor = currentMonday
  else if (weekSet.has(shiftWeeks(currentMonday, -1))) cursor = shiftWeeks(currentMonday, -1)
  while (cursor && weekSet.has(cursor)) {
    streakWeeks++
    cursor = shiftWeeks(cursor, -1)
  }

  return streakWeeks
}
