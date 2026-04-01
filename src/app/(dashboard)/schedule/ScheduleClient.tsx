'use client'

import { useState } from 'react'
import GeneralAvailability from './tabs/GeneralAvailability'
import DayToDay from './tabs/DayToDay'
import Holidays from './tabs/Holidays'

interface Profile {
  id: string
  full_name: string
  role: string
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
}

type TabId = 'general' | 'daytodday' | 'holidays'

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',    label: 'General Availability' },
  { id: 'daytodday',  label: 'Day to Day' },
  { id: 'holidays',   label: 'Holidays' },
]

export default function ScheduleClient({ profile, initialAvailability }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  // The FULL availability list lives here.
  // Every tab receives this full list and is responsible for merging
  // its changes back into the full list before calling onAvailabilityChange.
  // This prevents any tab from accidentally wiping another tab's records.
  const [availability, setAvailability] = useState<AvailabilityRecord[]>(initialAvailability)

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">
        Schedule &amp; Availability
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Manage your weekly availability, specific day adjustments, and holiday periods.
      </p>

      {/* Tab buttons */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'px-4 py-2 text-sm font-medium rounded-t-md transition-colors',
              activeTab === tab.id
                ? 'bg-white border border-b-white border-gray-200 text-[#FF8303] -mb-px'
                : 'text-gray-500 hover:text-gray-800',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content — all three tabs receive the FULL availability array */}
      <div>
        {activeTab === 'general' && (
          <GeneralAvailability
            profile={profile}
            availability={availability}
            onAvailabilityChange={setAvailability}
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