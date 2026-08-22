'use client'

import { Check } from 'lucide-react'

// "Connect Google Calendar" card for the teacher Schedule page.
//
// ADMIN-ONLY, ENFORCED SERVER-SIDE. This component holds no role check of its
// own: page.tsx passes `connection: null` for every non-admin caller and
// ScheduleClient renders nothing at all in that case, so the card is ABSENT for
// a normal teacher, not merely disabled.
//
// It is handed a minimal, already-safe summary. Tokens never leave the server -
// the page reads only id + google_email out of google_calendar_connections, so
// there is nothing token-shaped in this component's props to leak into the
// client bundle.

const BRAND = '#FF8303'
const CARD_EDGE = '#E0DFDC'
const SUCCESS = '#16A34A'
const SUCCESS_TINT = '#F0FDF4'
const SUCCESS_EDGE = '#BBF7D0'
const DANGER = '#DC2626'
const DANGER_TINT = '#FEF2F2'
const DANGER_EDGE = '#FECACA'
const TEXT_STRONG = '#111827'
const TEXT_MUTED = '#6b7280'

/** Exactly what the client is allowed to know about the connection. */
export interface GoogleConnectionSummary {
  connected: boolean
  email: string | null
}

/**
 * Outcome of the OAuth round trip, derived from ?google= on the server.
 *
 * Deliberately reduced to success/error before it reaches the browser: the raw
 * outcome code is a server-log detail, never user-facing copy.
 */
export type GoogleNotice = 'success' | 'error' | null

export default function GoogleConnectCard({
  connection,
  notice,
}: {
  connection: GoogleConnectionSummary
  notice: GoogleNotice
}) {
  return (
    <div
      style={{
        border: `1px solid ${CARD_EDGE}`,
        borderRadius: '8px',
        padding: '16px 20px',
        marginBottom: '24px',
        backgroundColor: '#FFFFFF',
      }}
    >
      <h2 style={{ fontSize: '15px', fontWeight: 600, color: TEXT_STRONG, margin: 0 }}>
        Google Calendar
      </h2>

      {connection.connected ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginTop: '10px',
            }}
          >
            <Check size={16} aria-hidden="true" style={{ color: SUCCESS, flexShrink: 0 }} />
            <span style={{ fontSize: '14px', fontWeight: 500, color: SUCCESS }}>
              {connection.email ? `Connected as ${connection.email}` : 'Connected'}
            </span>
          </div>
          <p style={{ fontSize: '13px', color: TEXT_MUTED, marginTop: '6px' }}>
            Busy events from Google appear on your calendar within 15 minutes.
          </p>
        </>
      ) : (
        <>
          <p style={{ fontSize: '13px', color: TEXT_MUTED, marginTop: '8px' }}>
            Connect your Google Calendar so outside appointments block your availability
            automatically.
          </p>
          {/* Plain <a>, never fetch(): this must be a top-level navigation so the
              browser follows the 302 out to Google's consent screen. An XHR would
              hit CORS and go nowhere. Not a next/link either - the target is an
              API route, so there is nothing for the router to prefetch. */}
          <a
            href="/api/google/oauth/start"
            style={{
              display: 'inline-block',
              marginTop: '12px',
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: BRAND,
              color: '#FFFFFF',
              fontSize: '14px',
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Connect Google Calendar
          </a>
        </>
      )}

      {/* Derived from searchParams on every render, held in no state: navigating
          away drops it, and it never reappears on a later visit. */}
      {notice && (
        <div
          role="status"
          style={{
            marginTop: '12px',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '13px',
            backgroundColor: notice === 'success' ? SUCCESS_TINT : DANGER_TINT,
            border: `1px solid ${notice === 'success' ? SUCCESS_EDGE : DANGER_EDGE}`,
            color: notice === 'success' ? SUCCESS : DANGER,
          }}
        >
          {notice === 'success'
            ? 'Google Calendar connected.'
            : 'Connection failed - please try again.'}
        </div>
      )}
    </div>
  )
}
