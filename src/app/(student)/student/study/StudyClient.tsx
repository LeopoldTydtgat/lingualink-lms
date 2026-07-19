'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, CheckCircle, Clock, Search } from 'lucide-react'
import { EmptyStudy } from '@/components/EmptyStudy'
import { categoryBadgeStyle } from '@/lib/study/categoryBadge'
import DifficultyBars from '@/components/study/DifficultyBars'

// ── Types ────────────────────────────────────────────────────────────────────

interface StudySheet {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  is_active: boolean
}

interface Assignment {
  id: string
  lesson_id: string
  assigned_at: string
  study_sheet: StudySheet | null
}

interface Props {
  studentId: string
  assignments: Assignment[]
  completedAssignmentIds: string[]
  practicedSheetIds: string[]
  library: StudySheet[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Category pill, shared styling keyed on canonical lowercase casing */
function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium capitalize" style={categoryBadgeStyle(category)}>
      {category}
    </span>
  )
}

/** Formats a date string to a readable short date, e.g. "17 Jul 2026" */
function formatDate(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

// ── Reusable buttons (hover via handlers — Tailwind v4 dynamic-class rule) ─────

/** Solid orange primary action */
function StartButton({ label, onClick, size = 'md' }: { label: string; onClick: () => void; size?: 'sm' | 'md' }) {
  const [hovered, setHovered] = useState(false)
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`${pad} rounded-lg font-semibold transition-colors`}
      style={{ backgroundColor: hovered ? '#E67502' : '#FF8303', color: '#ffffff' }}
    >
      {label}
    </button>
  )
}

/** Tinted-outline secondary action (Review) */
function ReviewButton({ label, onClick, size = 'md' }: { label: string; onClick: () => void; size?: 'sm' | 'md' }) {
  const [hovered, setHovered] = useState(false)
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`${pad} rounded-lg font-semibold transition-colors`}
      style={{
        backgroundColor: hovered ? '#FFE4C4' : '#FFF0E0',
        color: '#FF8303',
        border: '1px solid #FFD9A8',
      }}
    >
      {label}
    </button>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  icon,
  chipBg,
  label,
  count,
  caption,
}: {
  icon: React.ReactNode
  chipBg: string
  label: string
  count: number
  caption: string
}) {
  return (
    <div className="rounded-xl bg-white shadow-sm p-4" style={{ border: '1px solid #f3f4f6' }}>
      <div className="flex items-center gap-2">
        <span
          className="flex items-center justify-center rounded-lg flex-shrink-0"
          style={{ width: '36px', height: '36px', backgroundColor: chipBg }}
        >
          {icon}
        </span>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-3">{count}</p>
      <p className="text-xs text-gray-400 mt-1">{caption}</p>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export default function StudyClient({ studentId, assignments, completedAssignmentIds, practicedSheetIds, library }: Props) {
  const router = useRouter()
  const [activeSection, setActiveSection] = useState<'assigned' | 'practice'>('assigned')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterCategory, setFilterCategory] = useState('')

  const completedAssignmentIdSet = new Set(completedAssignmentIds)
  const practicedSheetIdSet = new Set(practicedSheetIds)

  // Separate pending vs completed assignments.
  // Pending on a deactivated sheet is hidden entirely; completed on a
  // deactivated sheet stays visible (rendered non-clickable below).
  const pendingAssignments = assignments.filter(
    (a) => a.study_sheet && a.study_sheet.is_active && !completedAssignmentIdSet.has(a.id)
  )
  const completedAssignments = assignments.filter(
    (a) => a.study_sheet && completedAssignmentIdSet.has(a.id)
  )

  // "This Week" — assignments (any status) on an active sheet assigned in the last 7 days
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  const thisWeekCount = assignments.filter(
    (a) => a.study_sheet && a.study_sheet.is_active && new Date(a.assigned_at).getTime() >= weekAgoMs
  ).length

  // Badge counts only pending, active-sheet assignments
  const pendingCount = pendingAssignments.length

  // Filter the library based on search and dropdowns
  const filteredLibrary = library.filter((sheet) => {
    const matchesSearch = sheet.title.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesLevel = filterLevel ? sheet.level === filterLevel : true
    const matchesCategory = filterCategory ? sheet.category === filterCategory : true
    return matchesSearch && matchesLevel && matchesCategory
  })

  // Navigate to individual sheet — pass assignment id if it's assigned homework
  function openSheet(sheetId: string, assignmentId?: string) {
    const url = assignmentId
      ? `/student/study/${sheetId}?assignment=${assignmentId}`
      : `/student/study/${sheetId}`
    router.push(url)
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page title */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', width: '100%' }}>
        <h1 className="text-2xl font-bold text-gray-900">Study</h1>
        <p className="text-sm text-gray-500 mt-1">
          Complete your assigned homework or practice independently.
        </p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={<Clock size={18} style={{ color: '#FF8303' }} />}
          chipBg="#FFF0E0"
          label="To Do"
          count={pendingAssignments.length}
          caption="Assignments waiting"
        />
        <StatCard
          icon={<CheckCircle size={18} style={{ color: '#16A34A' }} />}
          chipBg="#DCFCE7"
          label="Completed"
          count={completedAssignments.length}
          caption="Assignments finished"
        />
        <StatCard
          icon={<CalendarDays size={18} style={{ color: '#FF8303' }} />}
          chipBg="#FFF0E0"
          label="This Week"
          count={thisWeekCount}
          caption="Assigned in the last 7 days"
        />
      </div>

      {/* Section toggle (manual tabs — shadcn Tabs broken with Tailwind v4) */}
      <div className="flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setActiveSection('assigned')}
          className="relative flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeSection === 'assigned'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '190px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '190px' }
          }
        >
          Assigned by Your Teacher
          {pendingCount > 0 && (
            <span
              className="ml-2 inline-flex items-center justify-center rounded-full text-xs font-semibold px-1.5 py-0.5 text-white"
              style={{ backgroundColor: '#FF8303', minWidth: '20px' }}
            >
              {pendingCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSection('practice')}
          className="relative flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeSection === 'practice'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '190px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '190px' }
          }
        >
          Practice on Your Own
        </button>
      </div>

      {/* ── ASSIGNED SECTION ──────────────────────────────────────────────── */}
      {activeSection === 'assigned' && (
        <div>
          {pendingAssignments.length === 0 && completedAssignments.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <EmptyStudy />
              <p className="text-sm">No assignments yet. Your teacher will assign study sheets after your classes.</p>
            </div>
          ) : (
            <>
              {/* Pending assignments */}
              {pendingAssignments.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                    Pending
                    <span
                      className="ml-2 rounded-full text-xs px-2 py-0.5 font-medium"
                      style={{ backgroundColor: '#FFF0E0', color: '#FF8303' }}
                    >
                      {pendingAssignments.length}
                    </span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {pendingAssignments.map((a) => (
                      <AssignmentCard
                        key={a.id}
                        assignment={a}
                        status="pending"
                        onStart={() => openSheet(a.study_sheet!.id, a.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Completed assignments */}
              {completedAssignments.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                    Completed
                    <span
                      className="ml-2 rounded-full text-xs px-2 py-0.5 font-medium"
                      style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}
                    >
                      {completedAssignments.length}
                    </span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {completedAssignments.map((a) => (
                      <AssignmentCard
                        key={a.id}
                        assignment={a}
                        status="completed"
                        deactivated={!a.study_sheet!.is_active}
                        onStart={() => openSheet(a.study_sheet!.id, a.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── PRACTICE SECTION ──────────────────────────────────────────────── */}
      {activeSection === 'practice' && (
        <div>
          {/* Search and filters */}
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search by title..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 bg-white"
                style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
              />
            </div>

            <select
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none"
            >
              <option value="">All Levels</option>
              {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none"
            >
              <option value="">All Categories</option>
              <option value="vocabulary">Vocabulary</option>
              <option value="grammar">Grammar</option>
            </select>
          </div>

          {/* Library card grid */}
          {filteredLibrary.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <p className="text-sm">No study sheets match your filters.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredLibrary.map((sheet) => {
                const practiced = practicedSheetIdSet.has(sheet.id)
                return (
                  <div
                    key={sheet.id}
                    className="flex flex-col rounded-xl bg-white shadow-sm p-4"
                    style={{ border: '1px solid #f3f4f6' }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-gray-900 text-sm">{sheet.title}</p>
                      {practiced && (
                        <span
                          className="rounded-full text-xs px-2 py-0.5 font-medium flex-shrink-0"
                          style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}
                        >
                          Done
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 mt-2">
                      <CategoryBadge category={sheet.category} />
                      <span className="text-xs text-gray-500">{sheet.level}</span>
                      <DifficultyBars count={sheet.difficulty ?? 1} />
                    </div>

                    <div className="mt-auto pt-3">
                      {practiced ? (
                        <ReviewButton label="Review" size="sm" onClick={() => openSheet(sheet.id)} />
                      ) : (
                        <StartButton label="Start" size="sm" onClick={() => openSheet(sheet.id)} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Assignment Card sub-component ─────────────────────────────────────────────

function AssignmentCard({
  assignment,
  status,
  onStart,
  deactivated = false,
}: {
  assignment: Assignment
  status: 'pending' | 'completed'
  onStart: () => void
  deactivated?: boolean
}) {
  const sheet = assignment.study_sheet!

  const spineColor = deactivated
    ? '#e5e7eb'
    : status === 'pending'
    ? '#FF8303'
    : '#16A34A'

  return (
    <div
      className="flex items-center justify-between px-4 py-4 rounded-xl bg-white shadow-sm"
      style={{
        border: '1px solid #f3f4f6',
        borderLeft: `3px solid ${spineColor}`,
        backgroundColor: deactivated ? '#f9fafb' : '#ffffff',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: deactivated ? '#f3f4f6' : status === 'pending' ? '#fff7ed' : '#dcfce7',
          }}
        >
          {status === 'pending' ? (
            <Clock size={15} style={{ color: '#FF8303' }} />
          ) : (
            <CheckCircle size={15} style={{ color: deactivated ? '#9ca3af' : '#16a34a' }} />
          )}
        </div>

        <div>
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-900 text-sm">{sheet.title}</p>
            {status === 'completed' && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}
              >
                Completed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <CategoryBadge category={sheet.category} />
            <span className="text-xs text-gray-500">{sheet.level}</span>
            <DifficultyBars count={sheet.difficulty ?? 1} />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Assigned {formatDate(assignment.assigned_at)}
          </p>
        </div>
      </div>

      {deactivated ? (
        <span className="ml-4 text-xs font-medium" style={{ color: '#9ca3af' }}>
          No longer available
        </span>
      ) : (
        <div className="ml-4">
          {status === 'pending' ? (
            <StartButton label="Start" onClick={onStart} />
          ) : (
            <ReviewButton label="Review" onClick={onStart} />
          )}
        </div>
      )}
    </div>
  )
}
