function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Format an ISO datetime string as a UTC ICS timestamp e.g. "20260414T080000Z"
export function toIcsDate(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// Escape a TEXT value for ICS (RFC 5545): backslash first, then ';' ',' and newlines.
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n/g, '\\n')
}

interface IcsEvent {
  uid: string
  startIso: string
  endIso: string
  summary: string
  description: string
}

export function buildIcsCalendar(events: IcsEvent[]): string {
  const stamp = toIcsDate(new Date().toISOString())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LinguaLink Online//Teacher Portal//EN',
  ]
  events.forEach(e => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDate(e.startIso)}`,
      `DTEND:${toIcsDate(e.endIso)}`,
      `SUMMARY:${escapeIcsText(e.summary)}`,
      `DESCRIPTION:${escapeIcsText(e.description)}`,
      'END:VEVENT',
    )
  })
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}
