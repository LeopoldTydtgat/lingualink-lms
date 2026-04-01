'use client'

import { useState, useEffect } from 'react'
import { format, isToday, isTomorrow } from 'date-fns'

type Student = {
  id: string
  full_name: string
  photo_url: string | null
}

type Class = {
  id: string
  starts_at: string
  ends_at: string
  status: string
  teams_link: string | null
  lesson_notes: string | null
  student: Student
}

type Profile = {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

type Props = {
  classes: Class[]
  profile: Profile
}

function groupByDay(classes: Class[]): Record<string, Class[]> {
  return classes.reduce((groups, cls) => {
    const day = format(new Date(cls.starts_at), 'yyyy-MM-dd')
    if (!groups[day]) groups[day] = []
    groups[day].push(cls)
    return groups
  }, {} as Record<string, Class[]>)
}

function formatDayHeading(dateStr: string): string {
  const date = new Date(dateStr)
  if (isToday(date)) return 'Today'
  if (isTomorrow(date)) return 'Tomorrow'
  return format(date, 'EEE d MMM')
}

function Countdown({ startsAt }: { startsAt: string }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    function update() {
      const diff = new Date(startsAt).getTime() - Date.now()
      if (diff <= 0) {
        setTimeLeft('Starting now')
        return
      }
      const hours = Math.floor(diff / 1000 / 60 / 60)
      const minutes = Math.floor((diff / 1000 / 60) % 60)
      const seconds = Math.floor((diff / 1000) % 60)
      setTimeLeft(
        hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's'
      )
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [startsAt])

  return <span className="font-mono text-sm text-orange-500">{timeLeft}</span>
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: rotated ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
        color: '#9ca3af',
        flexShrink: 0
      }}
    >
      <path d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function ClassCard({ cls }: { cls: Class }) {
  const [expanded, setExpanded] = useState(false)
  const startTime = format(new Date(cls.starts_at), 'HH:mm')
  const endTime = format(new Date(cls.ends_at), 'HH:mm')
  const minutesUntilClass = (new Date(cls.starts_at).getTime() - Date.now()) / 1000 / 60
  const showJoinButton = minutesUntilClass <= 15 && minutesUntilClass > -60

  function handleJoinClass() {
    if (cls.teams_link) {
      window.open(cls.teams_link, '_blank')
    }
  }

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
          {cls.student.photo_url ? (
            <img
              src={cls.student.photo_url}
              alt={cls.student.full_name}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <span className="text-orange-500 font-semibold text-sm">
              {cls.student.full_name.charAt(0)}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900">{cls.student.full_name}</p>
          <p className="text-sm text-gray-500">{startTime} - {endTime}</p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <Countdown startsAt={cls.starts_at} />
          <ChevronIcon rotated={expanded} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4 bg-gray-50">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Lesson Notes / To-do
            </p>
            <p className="text-sm text-gray-700">
              {cls.lesson_notes ?? 'No notes added yet.'}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {showJoinButton && cls.teams_link && (
              <button
                onClick={handleJoinClass}
                className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 transition-colors"
              >
                Join Class
              </button>
            )}
            <button className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-white transition-colors">
              Reschedule
            </button>
            <button className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-white transition-colors">
              {'Chat with ' + cls.student.full_name.split(' ')[0]}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DayGroup({ dateStr, classes }: { dateStr: string; classes: Class[] }) {
  const [open, setOpen] = useState(true)
  const heading = formatDayHeading(dateStr)

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-left w-full"
      >
        <span className="font-semibold text-gray-800">{heading}</span>
        <span className="text-sm text-gray-400">
          {classes.length} {classes.length === 1 ? 'lesson' : 'lessons'}
        </span>
        <div className="ml-auto">
          <ChevronIcon rotated={open} />
        </div>
      </button>

      {open && (
        <div className="space-y-2">
          {classes.map(cls => (
            <ClassCard key={cls.id} cls={cls} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function UpcomingClassesClient({ classes, profile }: Props) {
  const grouped = groupByDay(classes)
  const days = Object.keys(grouped).sort()

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Upcoming Classes</h1>
          <p className="text-sm text-gray-500 mt-1">
            {classes.length} {classes.length === 1 ? 'class' : 'classes'} scheduled
          </p>
        </div>

        {profile.role === 'admin' && (
          <button className="px-4 py-2 bg-orange-500 text-white text-sm font-semibold rounded-lg hover:bg-orange-600 transition-colors">
            + Add Class
          </button>
        )}
      </div>

      {days.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No upcoming classes.</p>
          <p className="text-sm mt-1">Enjoy the break!</p>
        </div>
      ) : (
        <div className="space-y-8">
          {days.map(day => (
            <DayGroup key={day} dateStr={day} classes={grouped[day]} />
          ))}
        </div>
      )}
    </div>
  )
}