'use client'

import { useState } from 'react'
import { X, Search, Check } from 'lucide-react'

type Student = { id: string; full_name: string; email: string }

type Props = {
  sheetId: string
  sheetTitle: string
  students: Student[]
  onClose: () => void
  onSaved: () => void
}

type Result = { assigned: number; skipped: number }

export default function AssignWorksheetModal({
  sheetId,
  sheetTitle,
  students,
  onClose,
  onSaved,
}: Props) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filtered = students.filter(s =>
    s.full_name.toLowerCase().includes(search.toLowerCase())
  )
  const allFilteredSelected =
    filtered.length > 0 && filtered.every(s => selected.has(s.id))

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) filtered.forEach(s => next.delete(s.id))
      else filtered.forEach(s => next.add(s.id))
      return next
    })
  }

  async function handleAssign() {
    if (selected.size === 0) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/teacher/library/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ study_sheet_id: sheetId, student_ids: [...selected] }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not assign this worksheet. Please try again.')
        setSaving(false)
        return
      }
      setResult({
        assigned: Array.isArray(body.assigned) ? body.assigned.length : 0,
        skipped: Array.isArray(body.skipped) ? body.skipped.length : 0,
      })
      setSaving(false)
      // Refresh the underlying server data so counts/badges update behind the
      // summary. The modal stays open on its result screen until Close.
      onSaved()
    } catch {
      setError('Could not assign this worksheet. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid #E0DFDC' }}>
          <div>
            <h2 className="font-semibold" style={{ color: '#111827' }}>Assign to Students</h2>
            <p className="text-sm mt-0.5" style={{ color: '#9ca3af' }}>{sheetTitle}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2"
            style={{ color: '#9ca3af' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#4b5563')}
            onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          /* Result summary */
          <div className="px-6 py-8 flex-1 flex flex-col items-center justify-center text-center gap-2">
            <span
              className="flex items-center justify-center rounded-full mb-2"
              style={{ width: '48px', height: '48px', backgroundColor: '#FFF3E0' }}
            >
              <Check className="w-6 h-6" style={{ color: '#FF8303' }} />
            </span>
            <p className="text-sm font-medium" style={{ color: '#111827' }}>
              {result.assigned} {result.assigned === 1 ? 'student' : 'students'} assigned
            </p>
            {result.skipped > 0 && (
              <p className="text-xs" style={{ color: '#9ca3af' }}>
                {result.skipped} already assigned this worksheet
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Search + select all */}
            <div className="px-6 py-3 space-y-2" style={{ borderBottom: '1px solid #E0DFDC' }}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9ca3af' }} />
                <input
                  placeholder="Search students..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full rounded-md text-sm pl-9 pr-3 py-2 border"
                  style={{ borderColor: '#E0DFDC', color: '#111827' }}
                />
              </div>
              {filtered.length > 0 && (
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs font-medium"
                    style={{ color: '#FF8303' }}
                  >
                    {allFilteredSelected ? 'Clear all' : 'Select all'}
                  </button>
                  <span className="text-xs" style={{ color: '#9ca3af' }}>
                    {selected.size} selected
                  </span>
                </div>
              )}
            </div>

            {/* Student list */}
            <div className="flex-1 overflow-y-auto px-6 py-3 thin-scroll">
              {students.length === 0 ? (
                <p className="text-sm text-center py-8" style={{ color: '#9ca3af' }}>
                  You have no students to assign to yet.
                </p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-center py-8" style={{ color: '#9ca3af' }}>
                  No students match your search.
                </p>
              ) : (
                <div className="space-y-1">
                  {filtered.map(student => {
                    const isSelected = selected.has(student.id)
                    return (
                      <div
                        key={student.id}
                        onClick={() => toggle(student.id)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                        style={{
                          cursor: 'pointer',
                          backgroundColor: isSelected ? '#FFF3E0' : 'transparent',
                          border: isSelected ? '1px solid #FF8303' : '1px solid transparent',
                        }}
                      >
                        <div
                          className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0"
                          style={{
                            borderColor: isSelected ? '#FF8303' : '#d1d5db',
                            backgroundColor: isSelected ? '#FF8303' : 'white',
                          }}
                        >
                          {isSelected && (
                            <svg className="w-3 h-3" style={{ color: 'white' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: '#111827' }}>
                            {student.full_name}
                          </p>
                          <p className="text-xs truncate" style={{ color: '#9ca3af' }}>
                            {student.email}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <p className="px-6 pt-2 text-sm" style={{ color: '#FD5602' }}>{error}</p>
        )}

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-end gap-3" style={{ borderTop: '1px solid #E0DFDC' }}>
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 text-sm rounded-md text-white font-medium"
              style={{ backgroundColor: '#FF8303' }}
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-md border"
                style={{ borderColor: '#E0DFDC', color: '#4b5563', backgroundColor: 'white' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAssign}
                disabled={saving || selected.size === 0}
                className="px-5 py-2 text-sm rounded-md text-white font-medium"
                style={{ backgroundColor: '#FF8303', opacity: saving || selected.size === 0 ? 0.4 : 1 }}
              >
                {saving ? 'Assigning...' : 'Assign'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
