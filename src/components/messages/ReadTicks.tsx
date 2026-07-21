'use client'

// ─── Read ticks ───────────────────────────────────────────────────────────────
// Single tick = sent (grey). Double tick = read (orange).
// Only shown on messages sent by the current user.
//
// Shared by the teacher inbox, the support ChatWidget and the admin Messages
// viewer so the three portals never drift on tick colour or geometry.
export default function ReadTicks({
  readAt,
  variant = 'default',
  className = 'ml-1',
}: {
  readAt: string | null
  // 'bubble' = on-bubble placement (WhatsApp-style, inside an own message bubble):
  // lighter tick colours that read against the dark bubble fill. 'default' keeps the
  // metadata-row colours (grey sent, orange read).
  variant?: 'default' | 'bubble'
  className?: string
}) {
  const single = variant === 'bubble' ? 'rgba(255,255,255,0.7)' : '#9ca3af'
  const double = '#FF8303'
  if (readAt) {
    // Double tick — message has been read
    return (
      <span className={`inline-flex items-center gap-0.5 ${className}`} aria-label="Read">
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4L3.5 6.5L9 1" stroke={double} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M3.5 6.5L9 1" stroke={double} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style={{ marginLeft: '-4px' }}>
          <path d="M1 4L3.5 6.5L9 1" stroke={double} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    )
  }
  // Single tick — sent, not yet read
  return (
    <span className={`inline-flex items-center ${className}`} aria-label="Sent">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
        <path d="M1 4L3.5 6.5L9 1" stroke={single} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  )
}
