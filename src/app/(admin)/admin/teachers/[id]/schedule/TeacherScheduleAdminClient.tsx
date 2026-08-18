'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import GeneralAvailability from '@/app/(dashboard)/schedule/tabs/GeneralAvailability'
import DayToDay from '@/app/(dashboard)/schedule/tabs/DayToDay'
import Holidays from '@/app/(dashboard)/schedule/tabs/Holidays'
import type { AvailabilityRecord } from '@/app/(dashboard)/schedule/ScheduleClient'

interface Profile {
  id: string
  full_name: string
  role: string
  timezone: string
}

interface Props {
  teacher: Profile
  initialAvailability: AvailabilityRecord[]
  minAvailableHours: number | null
  timezoneUnconfirmed: boolean
}

type TabId = 'general' | 'daytoday' | 'holidays'

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',   label: 'General Availability' },
  { id: 'daytoday',  label: 'Day to Day' },
  { id: 'holidays',  label: 'Holidays' },
]

// Deliberately a separate wrapper rather than a widened ScheduleClient: the tab
// components ARE the calendar engine and are shared unchanged, while this file
// holds only chrome. That keeps the teacher portal, the most-tested surface in
// the repo, untouched by an admin-only feature.
export default function TeacherScheduleAdminClient({
  teacher,
  initialAvailability,
  minAvailableHours,
  timezoneUnconfirmed,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [availability, setAvailability] = useState<AvailabilityRecord[]>(initialAvailability)

  return (
    <div className="p-6">
      <button
        onClick={() => router.push(`/admin/teachers/${teacher.id}`)}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 mb-4"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <ArrowLeft size={15} />
        Back to teacher
      </button>

      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%' }}>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Schedule &amp; Availability
        </h1>
        <p className="text-sm text-gray-500">
          Managing {teacher.full_name}&apos;s schedule on their behalf. Changes take effect
          immediately and are visible to this teacher.
        </p>
      </div>

      {/* Times on every tab are the TEACHER's local times, not the admin's: the
          General Availability grid stores day_of_week + a plain TIME which is
          resolved against this teacher's timezone, and the Day to Day grid renders
          in it. Unlabelled, that silently offers students the wrong hour. */}
      <div
        style={{
          backgroundColor: '#FFF3E0',
          border: '1px solid #FFD9A8',
          color: '#7C3E00',
          padding: '10px 14px',
          borderRadius: '8px',
          marginBottom: timezoneUnconfirmed ? '12px' : '20px',
          fontSize: '13px',
          lineHeight: 1.5,
        }}
      >
        All times below are shown in {teacher.full_name}&apos;s timezone
        {teacher.timezone ? ` (${teacher.timezone})` : ''}, not yours.
      </div>

      {timezoneUnconfirmed && (
        <div
          role="alert"
          style={{
            backgroundColor: '#FFFBEB',
            border: '1px solid #FDE68A',
            color: '#92400E',
            padding: '10px 14px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '13px',
            lineHeight: 1.5,
          }}
        >
          This teacher has not confirmed their timezone yet. Recurring weekly slots are
          stored as plain times and will be read in whichever timezone they confirm, so
          they may not land at the hour you set here.
        </div>
      )}

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
            </button>
          )
        })}
      </div>

      {/* Every tab receives the FULL availability array and the raw setter, exactly
          as ScheduleClient does, so no tab can wipe another tab's records. */}
      <div>
        {activeTab === 'general' && (
          <GeneralAvailability
            profile={teacher}
            availability={availability}
            onAvailabilityChange={setAvailability}
            minAvailableHours={minAvailableHours}
          />
        )}
        {activeTab === 'daytoday' && (
          <DayToDay
            profile={teacher}
            availability={availability}
            onAvailabilityChange={setAvailability}
          />
        )}
        {activeTab === 'holidays' && (
          <Holidays
            profile={teacher}
            availability={availability}
            onAvailabilityChange={setAvailability}
          />
        )}
      </div>
    </div>
  )
}
