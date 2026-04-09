'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Student = {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  self_reported_level: string | null
}

type Training = {
  id: string
  status: string
  total_hours: number
  hours_consumed: number
  start_date: string
  end_date: string | null
  package_type: string | null
  teacher_id: string
  students: Student | null
  profiles: { id: string; full_name: string } | null
}

type Props = {
  currentTrainings: Training[]
  pastTrainings: Training[]
  isAdmin: boolean
}

export default function StudentsClient({ currentTrainings, pastTrainings, isAdmin }: Props) {
  const router = useRouter()
  const [searchCurrent, setSearchCurrent] = useState('')
  const [searchPast, setSearchPast] = useState('')

  const totalCount = currentTrainings.length + pastTrainings.length

  // Filter by student name against the search input
  const filteredCurrent = currentTrainings.filter(t =>
    t.students?.full_name.toLowerCase().includes(searchCurrent.toLowerCase())
  )
  const filteredPast = pastTrainings.filter(t =>
    t.students?.full_name.toLowerCase().includes(searchPast.toLowerCase())
  )

  function getInitials(name: string) {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  function TrainingCard({ training }: { training: Training }) {
    const student = training.students
    if (!student) return null

    const hoursRemaining = training.total_hours - training.hours_consumed
    const progressPercent = training.total_hours > 0
      ? Math.round((training.hours_consumed / training.total_hours) * 100)
      : 0

    return (
      <div
        className="bg-white border border-gray-200 rounded-lg p-4 cursor-pointer hover:shadow-md transition-shadow"
        onClick={() => router.push(`/students/${training.id}`)}
      >
        <div className="flex items-center gap-3 mb-3">
          {/* Student photo or initials avatar */}
          {student.photo_url ? (
            <img
              src={student.photo_url}
              alt={student.full_name}
              className="w-10 h-10 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0"
              style={{ backgroundColor: '#FF8303' }}
            >
              {getInitials(student.full_name)}
            </div>
          )}
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">{student.full_name}</p>
            {/* Show assigned teacher name — useful for admin view */}
            {isAdmin && training.profiles && (
              <p className="text-xs text-gray-500 truncate">Teacher: {training.profiles.full_name}</p>
            )}
          </div>
        </div>

        {/* Training hours progress bar */}
        <div className="mb-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{training.hours_consumed}h used</span>
            <span>{hoursRemaining}h remaining</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-1.5">
            <div
              className="h-1.5 rounded-full"
              style={{ width: `${progressPercent}%`, backgroundColor: '#FF8303' }}
            />
          </div>
        </div>

        <div className="flex justify-between text-xs text-gray-500">
          <span>{training.package_type ?? 'Standard'}</span>
          <span>Ends {formatDate(training.end_date)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Students & Trainings</h1>
        <p className="text-sm text-gray-500 mt-1">{totalCount} total training{totalCount !== 1 ? 's' : ''}</p>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

        {/* LEFT — Current Trainings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              Current Trainings
              <span className="ml-2 text-sm font-normal text-gray-500">({currentTrainings.length})</span>
            </h2>
          </div>
          <input
            type="text"
            placeholder="Search students..."
            value={searchCurrent}
            onChange={e => setSearchCurrent(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2"
            style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
          />
          {filteredCurrent.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No current trainings found.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredCurrent.map(t => <TrainingCard key={t.id} training={t} />)}
            </div>
          )}
        </div>

        {/* RIGHT — Past Trainings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              Past Trainings
              <span className="ml-2 text-sm font-normal text-gray-500">({pastTrainings.length})</span>
            </h2>
          </div>
          <input
            type="text"
            placeholder="Search students..."
            value={searchPast}
            onChange={e => setSearchPast(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2"
            style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
          />
          {filteredPast.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No past trainings found.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredPast.map(t => <TrainingCard key={t.id} training={t} />)}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}