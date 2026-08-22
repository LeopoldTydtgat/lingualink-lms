'use client'

import { useState } from 'react'
import GeneralAvailability from './tabs/GeneralAvailability'
import DayToDay from './tabs/DayToDay'
import Holidays from './tabs/Holidays'
import CalendarSubscriptionCard from '@/components/shared/CalendarSubscriptionCard'
import GoogleConnectCard, {
  type GoogleConnectionSummary,
  type GoogleNotice,
} from './GoogleConnectCard'

// Same danger triple GoogleConnectCard uses for its failure notice, so the two
// red states on this page are one colour language rather than two.
const DANGER = '#DC2626'
const DANGER_TINT = '#FEF2F2'
const DANGER_EDGE = '#FECACA'

interface Profile {
  id: string
  full_name: string
  role: string
  timezone: string
}

export interface AvailabilityRecord {
  id: string
  teacher_id: string
  type: 'general' | 'specific' | 'holiday'
  day_of_week: number | null
  start_time: string | null
  end_time: string | null
  start_at: string | null
  end_at: string | null
  is_available: boolean
  // Row owner: 'manual' = drawn in the portal, 'google_sync' = mirrored from the
  // teacher's Google Calendar and read-only here (the DELETE route refuses it).
  // OPTIONAL on purpose: POST /api/teacher/availability does not return the
  // column, so rows appended optimistically from its response carry no source.
  // Absent therefore means manual - a row just created through the portal is
  // manual by construction, and only the branch source === 'google_sync' ever
  // changes behaviour.
  source?: string | null
}

interface Props {
  profile: Profile
  initialAvailability: AvailabilityRecord[]
  minAvailableHours: number | null
  // Finished banner text, or null when there is nothing to warn about. The
  // admin-only gate, the failure threshold and the fail-safe default all live
  // server-side in page.tsx — this component only renders what it is handed.
  googleSyncWarning: string | null
  // Google revoked the grant: a hard state that only a reconnect clears. page.tsx
  // never sets this and googleSyncWarning together, and the render below is an
  // if/else chain, so the two banners can never both appear.
  googleSyncRevoked: boolean
  // Google Calendar connect card. NULL MEANS "DO NOT RENDER THE CARD AT ALL":
  // page.tsx passes null for every non-admin caller, so a normal teacher never
  // sees the card in any form. Only ever carries connected + email; the token
  // columns are not read server-side, let alone passed here.
  googleConnection: GoogleConnectionSummary | null
  // Outcome of a just-completed OAuth round trip, already reduced to
  // success/error from ?google= on the server. Derived per render from
  // searchParams and stored in no state, so it cannot survive navigation.
  googleNotice: GoogleNotice
}

type TabId = 'general' | 'daytodday' | 'holidays'

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',    label: 'General Availability' },
  { id: 'daytodday',  label: 'Day to Day' },
  { id: 'holidays',   label: 'Holidays' },
]

export default function ScheduleClient({ profile, initialAvailability, minAvailableHours, googleSyncWarning, googleSyncRevoked, googleConnection, googleNotice }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  // The FULL availability list lives here.
  // Every tab receives this full list and is responsible for merging
  // its changes back into the full list before calling onAvailabilityChange.
  // This prevents any tab from accidentally wiping another tab's records.
  const [availability, setAvailability] = useState<AvailabilityRecord[]>(initialAvailability)

  return (
    <div className="p-6">
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%' }}>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Schedule &amp; Availability
        </h1>
        <p className="text-sm text-gray-500">
          Manage your weekly availability, specific day adjustments, and holiday periods.
        </p>
      </div>

      {/* Google busy-sync health. Neither banner is dismissable: they stay until
          the sync recovers, because a hidden banner means silently taking
          bookings over her real commitments.

          ONE CHAIN, SO ONLY ONE CAN RENDER. Revoked wins: it is the actionable
          state, and page.tsx already suppresses the transient warning whenever
          it sets this flag. The chain is the structural backstop for that. */}
      {googleSyncRevoked ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            backgroundColor: DANGER_TINT,
            border: `1px solid ${DANGER_EDGE}`,
            color: DANGER,
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '14px',
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontWeight: 500 }}>
            Google Calendar connection lost - your calendar is no longer syncing. Reconnect to
            resume.
          </span>
          {/* Plain <a>, exactly as on the Connect card: this must be a top-level
              navigation so the browser follows the 302 out to Google's consent
              screen. fetch() would hit CORS and go nowhere, and next/link would
              try to prefetch an API route. */}
          <a
            href="/api/google/oauth/start"
            style={{
              flexShrink: 0,
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: DANGER,
              color: '#FFFFFF',
              fontSize: '14px',
              fontWeight: 500,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Reconnect Google Calendar
          </a>
        </div>
      ) : googleSyncWarning ? (
        <div
          role="alert"
          style={{
            backgroundColor: '#FD5602',
            color: '#FFFFFF',
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '14px',
            lineHeight: 1.5,
          }}
        >
          {googleSyncWarning}
        </div>
      ) : null}

      {/* Admin-only, gated server-side: null means absent, not disabled. */}
      {googleConnection && (
        <GoogleConnectCard connection={googleConnection} notice={googleNotice} />
      )}

      {/* Tab buttons — the calendar subscription trigger rides the same row,
          pushed right, so it is reachable from any tab without scrolling. */}
      <div className="flex gap-6 items-end mb-6">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'relative text-sm font-medium transition-colors',
                isActive ? '' : 'text-gray-500 hover:text-gray-800',
              ].join(' ')}
              style={
                isActive
                  ? { backgroundColor: '#FFF3E0', color: '#FF8303', padding: '8px 15px', borderRadius: '8px', border: '1px solid #FFD9A8' }
                  : { padding: '0 4px 10px' }
              }
            >
              {tab.label}
              {isActive && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    bottom: '-8px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 0,
                    height: 0,
                    borderLeft: '10px solid transparent',
                    borderRight: '10px solid transparent',
                    borderTop: '8px solid #FFD9A8',
                    zIndex: 1,
                  }}
                />
              )}
            </button>
          )
        })}
        <div style={{ marginLeft: 'auto', paddingBottom: '2px' }}>
          <CalendarSubscriptionCard />
        </div>
      </div>

      {/* Tab content — all three tabs receive the FULL availability array */}
      <div>
        {activeTab === 'general' && (
          <GeneralAvailability
            profile={profile}
            availability={availability}
            onAvailabilityChange={setAvailability}
            minAvailableHours={minAvailableHours}
          />
        )}
        {activeTab === 'daytodday' && (
          <DayToDay
            profile={profile}
            availability={availability}
            onAvailabilityChange={setAvailability}
          />
        )}
        {activeTab === 'holidays' && (
          <Holidays
            profile={profile}
            availability={availability}
            onAvailabilityChange={setAvailability}
          />
        )}
      </div>
    </div>
  )
}
