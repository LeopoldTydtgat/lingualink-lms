'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BookOpen, CheckCircle, Clock, Search } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface StudySheet {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
}

interface Assignment {
  id: string
  lesson_id: string
  assigned_at: string
  study_sheet: StudySheet | null
}

interface Completion {
  id: string
  sheet_id: string
  assignment_id: string | null
  completed_at: string
  score: number | null
}

interface Props {
  studentId: string
  assignments: Assignment[]
  completions: Completion[]
  library: StudySheet[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if any completion row references this assignment */
function isAssignmentCompleted(assignmentId: string, completions: Completion[]) {
  return completions.some((c) => c.assignment_id === assignmentId)
}

/** Returns true if the student has done self-directed practice on this sheet */
function isPracticed(sheetId: string, completions: Completion[]) {
  return completions.some((c) => c.sheet_id === sheetId && c.assignment_id === null)
}

/** Renders difficulty bar icons */
function DifficultyBars({ count }: { count: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '16px' }}>
      {[1, 2, 3].map(n => (
        <span key={n} style={{
          display: 'inline-block',
          width: '5px',
          height: n === 1 ? '6px' : n === 2 ? '10px' : '14px',
          borderRadius: '2px',
          backgroundColor: n <= count ? '#FF8303' : '#e5e7eb',
        }} />
      ))}
    </span>
  )
}

/** Formats a date string to a readable short date */
function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Component ────────────────────────────────────────────────────────────────

export default function StudyClient({ studentId, assignments, completions, library }: Props) {
  const router = useRouter()
  const [activeSection, setActiveSection] = useState<'assigned' | 'practice'>('assigned')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterCategory, setFilterCategory] = useState('')

  // Count pending (incomplete) assignments
  const pendingCount = assignments.filter(
    (a) => a.study_sheet && !isAssignmentCompleted(a.id, completions)
  ).length

  // Separate pending vs completed assignments
  const pendingAssignments = assignments.filter(
    (a) => a.study_sheet && !isAssignmentCompleted(a.id, completions)
  )
  const completedAssignments = assignments.filter(
    (a) => a.study_sheet && isAssignmentCompleted(a.id, completions)
  )

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
    <div className="p-6 max-w-4xl mx-auto">
      {/* Page title */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Study</h1>
        <p className="text-sm text-gray-500 mt-1">
          Complete your assigned homework or practice independently.
        </p>
      </div>

      {/* Section toggle (manual tabs — shadcn Tabs broken with Tailwind v4) */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <button
          onClick={() => setActiveSection('assigned')}
          className="relative pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeSection === 'assigned'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303' }
              : { color: '#6b7280', borderBottom: '2px solid transparent' }
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
          className="relative pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeSection === 'practice'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303' }
              : { color: '#6b7280', borderBottom: '2px solid transparent' }
          }
        >
          Practice on Your Own
        </button>
      </div>

      {/* ── ASSIGNED SECTION ──────────────────────────────────────────────── */}
      {activeSection === 'assigned' && (
        <div>
          {assignments.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <BookOpen size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No assignments yet. Your teacher will assign study sheets after your classes.</p>
            </div>
          ) : (
            <>
              {/* Pending assignments */}
              {pendingAssignments.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                    Pending ({pendingAssignments.length})
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
                    Completed ({completedAssignments.length})
                  </h2>
                  <div className="flex flex-col gap-3">
                    {completedAssignments.map((a) => (
                      <AssignmentCard
                        key={a.id}
                        assignment={a}
                        status="completed"
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
              <option value="Vocabulary">Vocabulary</option>
              <option value="Grammar">Grammar</option>
            </select>
          </div>

          {/* Library table */}
          {filteredLibrary.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <p className="text-sm">No study sheets match your filters.</p>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Title</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Category</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Level</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Difficulty</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLibrary.map((sheet, idx) => {
                    const practiced = isPracticed(sheet.id, completions)
                    return (
                      <tr
                        key={sheet.id}
                        className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                        style={{ borderBottom: '1px solid #f3f4f6' }}
                      >
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {sheet.title}
                          {practiced && (
                            <span className="ml-2 text-xs text-green-600 font-normal">✓ Done</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={
                              sheet.category === 'Vocabulary'
                                ? { backgroundColor: '#fff7ed', color: '#c2410c' }
                                : { backgroundColor: '#eff6ff', color: '#1d4ed8' }
                            }
                          >
                            {sheet.category}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{sheet.level}</td>
                        <td className="px-4 py-3">
                          <DifficultyBars count={sheet.difficulty ?? 1} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => openSheet(sheet.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
                            style={{ backgroundColor: '#FF8303' }}
                          >
                            {practiced ? 'Review' : 'Start'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
}: {
  assignment: Assignment
  status: 'pending' | 'completed'
  onStart: () => void
}) {
  const sheet = assignment.study_sheet!

  return (
    <div
      className="flex items-center justify-between px-4 py-4 rounded-xl border bg-white"
      style={{
        borderColor: status === 'pending' ? '#fed7aa' : '#d1fae5',
        backgroundColor: status === 'pending' ? '#fffbf5' : '#f0fdf4',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: status === 'pending' ? '#fff7ed' : '#dcfce7',
          }}
        >
          {status === 'pending' ? (
            <Clock size={15} style={{ color: '#FF8303' }} />
          ) : (
            <CheckCircle size={15} className="text-green-600" />
          )}
        </div>

        <div>
          <p className="font-semibold text-gray-900 text-sm">{sheet.title}</p>
          <div className="flex items-center gap-3 mt-1">
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={
                sheet.category === 'Vocabulary'
                  ? { backgroundColor: '#fff7ed', color: '#c2410c' }
                  : { backgroundColor: '#eff6ff', color: '#1d4ed8' }
              }
            >
              {sheet.category}
            </span>
            <span className="text-xs text-gray-500">{sheet.level}</span>
            <DifficultyBars count={sheet.difficulty ?? 1} />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Assigned {formatDate(assignment.assigned_at)}
          </p>
        </div>
      </div>

      <button
        onClick={onStart}
        className="ml-4 px-4 py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
        style={
          status === 'pending'
            ? { backgroundColor: '#FF8303', color: '#ffffff' }
            : { backgroundColor: '#f3f4f6', color: '#374151' }
        }
      >
        {status === 'pending' ? 'Start' : 'Review'}
      </button>
    </div>
  )
}
