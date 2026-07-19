'use client'

import type { ReactNode } from 'react'
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Gauge, Activity, History, Pencil, type LucideIcon } from 'lucide-react'
import { requireTz } from '@/lib/time/requireTz'

// ----- Types -----

interface Lesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
}

interface Training {
  id: string
  total_hours: number
  hours_consumed: number
  start_date: string | null
  end_date: string | null
  package_type: string | null
  status: string
}

interface LevelData {
  grammar?: string
  expression?: string
  comprehension?: string
  vocabulary?: string
  accent?: string
  overall_spoken?: string
  overall_written?: string
}

interface Props {
  student: { id: string; full_name: string; timezone: string; self_assessed_level: string | null }
  training: Training | null
  completedLessons: Lesson[]
  latestLevelData: LevelData | null
  latestLevelDate: string | null
  totalAssigned: number
  totalCompleted: number
}

// ----- CEFR conversion -----

const CEFR_TO_NUM: Record<string, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
}

const SKILL_LABELS: Record<keyof LevelData, string> = {
  grammar: 'Grammar',
  expression: 'Expression',
  comprehension: 'Comprehension',
  vocabulary: 'Vocabulary',
  accent: 'Accent',
  overall_spoken: 'Spoken',
  overall_written: 'Written',
}

// ----- Helpers -----

function formatDate(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(iso))
}

function hoursFromMinutes(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

// Decimal hours -> "Xh Ymin" (no bare "54.5h" anywhere)
function hoursToHm(hours: number) {
  return hoursFromMinutes(Math.round(hours * 60))
}

function avgClassesPerWeek(lessons: Lesson[]): string {
  if (lessons.length === 0) return '0'
  const dates = lessons.map(l => new Date(l.scheduled_at).getTime())
  const earliest = Math.min(...dates)
  const latest = Math.max(...dates)
  const diffWeeks = Math.max(1, (latest - earliest) / (1000 * 60 * 60 * 24 * 7))
  return (lessons.length / diffWeeks).toFixed(1)
}

// ----- Design-system primitives -----

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="shadow-sm"
      style={{ background: '#ffffff', border: '1px solid #f3f4f6', borderRadius: '12px', padding: '20px' }}
    >
      {children}
    </div>
  )
}

function CardHeader({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '16px' }}>
      <Icon size={14} color="#FF8303" />
      <span
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: '#9ca3af',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
    </div>
  )
}

// Inner stat block (no shadow, thin border) — repurposed from the old StatCard
function StatBlock({
  label,
  value,
  valueColor = '#111827',
  sub,
  subColor = '#9ca3af',
}: {
  label: string
  value: string
  valueColor?: string
  sub?: string
  subColor?: string
}) {
  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: '8px', padding: '12px' }}>
      <div
        style={{
          fontSize: '12px',
          color: '#9ca3af',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: valueColor, marginTop: '4px' }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: subColor, marginTop: '2px' }}>{sub}</div>}
    </div>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full text-xs font-medium px-2 py-0.5"
      style={{ background: '#f3f4f6', color: '#4b5563' }}
    >
      {children}
    </span>
  )
}

function ProgressBar({ value, max, colour = '#FF8303' }: { value: number; max: number; colour?: string }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100))
  return (
    <div className="w-full rounded-full" style={{ backgroundColor: '#E0DFDC', height: '8px' }}>
      <div
        className="rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: colour, height: '8px' }}
      />
    </div>
  )
}

// ----- Main component -----

export default function ProgressClient({
  student,
  training,
  completedLessons,
  latestLevelData,
  latestLevelDate,
  totalAssigned,
  totalCompleted,
}: Props) {
  const timezone = requireTz(student.timezone, 'progress:student')

  // ----- Training overview -----
  const totalHours = training?.total_hours ?? 0
  const hoursUsed = training ? parseFloat(training.hours_consumed.toString()) : 0
  const hoursRemaining = Math.max(0, totalHours - hoursUsed)
  const endDate = training?.end_date ? formatDate(training.end_date, timezone) : '—'
  const hoursPct = totalHours > 0 ? Math.round((hoursUsed / totalHours) * 100) : 0

  // ----- Lesson history -----
  const totalLessonsCount = completedLessons.length
  const totalMinutesLearned = completedLessons.reduce((sum, l) => sum + (l.duration_minutes ?? 0), 0)
  const avgPerWeek = avgClassesPerWeek(completedLessons)

  // ----- Radar chart data -----
  const radarData = latestLevelData
    ? (Object.keys(SKILL_LABELS) as (keyof LevelData)[])
        .filter(key => latestLevelData[key])
        .map(key => ({
          skill: SKILL_LABELS[key],
          value: CEFR_TO_NUM[latestLevelData[key] as string] ?? 0,
          label: latestLevelData[key],
        }))
    : []

  // ----- Exercises -----
  const pending = Math.max(0, totalAssigned - totalCompleted)
  const exercisePct = totalAssigned === 0 ? 0 : Math.round((totalCompleted / totalAssigned) * 100)

  return (
    <div className="p-6">

      {/* Page title */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%' }}>
        <h1 className="text-2xl font-bold text-gray-900">My Progress</h1>
        <p className="text-sm text-gray-500 mt-1">Track your learning journey and skill development</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ----- LEFT column ----- */}
        <div className="flex flex-col" style={{ gap: '16px' }}>

          {/* Training Overview */}
          <Card>
            <CardHeader icon={Gauge} label="Training Overview" />
            {training ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <StatBlock label="Total Hours" value={hoursToHm(totalHours)} />
                  <StatBlock label="Hours Used" value={hoursToHm(hoursUsed)} />
                  <StatBlock
                    label="Hours Remaining"
                    value={hoursToHm(hoursRemaining)}
                    sub={hoursRemaining < 2 ? 'Running low' : undefined}
                    subColor="#FD5602"
                  />
                  <StatBlock
                    label="Training Ends"
                    value={endDate}
                    sub={training.package_type ?? undefined}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Hours used</span>
                    <span className="font-medium">
                      {hoursToHm(hoursUsed)} of {hoursToHm(totalHours)} ({hoursPct}%)
                    </span>
                  </div>
                  <ProgressBar value={hoursUsed} max={totalHours} />
                </div>
              </div>
            ) : (
              <p className="text-center text-sm" style={{ color: '#9ca3af' }}>
                No active training found. Contact your admin if you believe this is an error.
              </p>
            )}
          </Card>

          {/* Class History */}
          <Card>
            <CardHeader icon={History} label="Class History" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatBlock label="Classes Completed" value={String(totalLessonsCount)} sub="all time" />
              <StatBlock
                label="Total Learning Time"
                value={hoursFromMinutes(totalMinutesLearned)}
                sub="hours in class"
              />
              <StatBlock label="Avg Classes / Week" value={avgPerWeek} sub="based on your history" />
            </div>
          </Card>

          {/* Exercises */}
          <Card>
            <CardHeader icon={Pencil} label="Exercises" />
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-gray-900">{totalAssigned}</p>
                  <p className="text-xs text-gray-500 mt-1">Assigned</p>
                </div>
                <div>
                  <p className="text-2xl font-bold" style={{ color: '#FF8303' }}>{totalCompleted}</p>
                  <p className="text-xs text-gray-500 mt-1">Completed</p>
                </div>
                <div>
                  <p className="text-2xl font-bold" style={{ color: '#9ca3af' }}>{pending}</p>
                  <p className="text-xs text-gray-500 mt-1">Pending</p>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Overall completion</span>
                  <span className="font-medium">{exercisePct}%</span>
                </div>
                <ProgressBar value={totalCompleted} max={totalAssigned} />
              </div>

              {totalAssigned === 0 && (
                <p className="text-xs text-center pt-1" style={{ color: '#9ca3af' }}>
                  Exercises assigned by your teacher will appear here.
                </p>
              )}
            </div>
          </Card>

        </div>

        {/* ----- RIGHT column ----- */}
        <div className="flex flex-col" style={{ gap: '16px' }}>

          {/* Level Tracker (visual hero) */}
          <Card>
            <CardHeader icon={Activity} label="Level Tracker" />
            {latestLevelDate && (
              <p className="text-xs mb-4" style={{ color: '#9ca3af' }}>
                Based on your teacher&apos;s assessment from {formatDate(latestLevelDate, timezone)}
              </p>
            )}

            {radarData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={360}>
                  <RadarChart data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
                    <PolarGrid stroke="#e5e7eb" />
                    <PolarAngleAxis
                      dataKey="skill"
                      tick={{ fontSize: 12, fill: '#6b7280', fontFamily: 'Inter, sans-serif' }}
                    />
                    <Radar
                      name="Level"
                      dataKey="value"
                      stroke="#FF8303"
                      fill="#FF8303"
                      fillOpacity={0.25}
                      strokeWidth={2}
                    />
                    {/* value typed as number | undefined - recharts passes ValueType which includes undefined */}
                    <Tooltip
                      formatter={(value: unknown, _name: unknown, item: { payload?: { label?: string } }) => [
                        item.payload?.label ?? String((value as number) ?? 0),
                        'Level',
                      ]}
                      contentStyle={{
                        fontSize: 12,
                        fontFamily: 'Inter, sans-serif',
                        borderRadius: 8,
                        border: '1px solid #e5e7eb',
                      }}
                    />
                  </RadarChart>
                </ResponsiveContainer>

                {/* Skill/level pairs as neutral pills */}
                <div className="mt-4 flex flex-wrap gap-2 justify-center">
                  {radarData.map(d => (
                    <Pill key={d.skill}>{d.skill}: {d.label}</Pill>
                  ))}
                </div>

                {/* CEFR scale hint */}
                <p className="text-xs text-center mt-4" style={{ color: '#9ca3af' }}>
                  Scale: A1 &#8594; A2 &#8594; B1 &#8594; B2 &#8594; C1 &#8594; C2
                </p>
              </>
            ) : (
              <p className="text-center text-sm" style={{ color: '#9ca3af' }}>
                Your level chart will appear here after your teacher submits your first assessment.
              </p>
            )}

            {student.self_assessed_level && (
              <div
                className="flex items-center gap-2 mt-4 pt-4"
                style={{ borderTop: '1px solid #f3f4f6' }}
              >
                <span className="text-xs" style={{ color: '#9ca3af' }}>Your self-assessed level:</span>
                <Pill>{student.self_assessed_level}</Pill>
              </div>
            )}
          </Card>

        </div>

      </div>
    </div>
  )
}
