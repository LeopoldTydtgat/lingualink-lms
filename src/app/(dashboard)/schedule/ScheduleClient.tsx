'use client'

import { useState } from 'react'
import GeneralAvailability from './tabs/GeneralAvailability'
import DayToDay from './tabs/DayToDay'
import Holidays from './tabs/Holidays'

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
}

interface Props {
  profile: Profile
  initialAvailability: AvailabilityRecord[]
  minAvailableHours: number | null
}

type TabId = 'general' | 'daytodday' | 'holidays'

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',    label: 'General Availability' },
  { id: 'daytodday',  label: 'Day to Day' },
  { id: 'holidays',   label: 'Holidays' },
]

export default function ScheduleClient({ profile, initialAvailability, minAvailableHours }: Props) {
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

      {/* Tab buttons */}
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
