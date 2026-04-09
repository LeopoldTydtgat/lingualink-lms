'use client'

import { useState } from 'react'
import { StudySheet } from './LibraryAdminClient'

type StudentOption = {
  id: string
  full_name: string
  email: string
}

type Props = {
  sheet: StudySheet
  students: StudentOption[]
  adminId: string
  onClose: () => void
}

export default function AssignSheetModal({ sheet, students, adminId, onClose }: Props) {
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAssign = async () => {
    if (!selectedStudentId) return
    setSaving(true)
    setError(null)

    const res = await fetch('/api/admin/library/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        study_sheet_id: sheet.id,
        student_id: selectedStudentId,
        assigned_by: adminId,
      }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Failed to assign sheet. Please try again.')
      setSaving(false)
      return
    }

    setSaving(false)
    setSuccess(true)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">Assign Sheet to Student</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {/* Sheet info */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
            <p className="text-xs text-gray-400 uppercase font-medium mb-0.5">Sheet</p>
            <p className="text-sm font-semibold text-gray-900">{sheet.title}</p>
            <p className="text-xs text-gray-500 mt-0.5 capitalize">{sheet.category} · {sheet.level}</p>
          </div>

          {success ? (
            <div className="text-center py-4 space-y-2">
              <p className="text-2xl">✅</p>
              <p className="text-sm font-medium text-gray-900">Sheet assigned successfully.</p>
              <p className="text-xs text-gray-500">
                The student will see this in their Study tab.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Student *
                </label>
                <select
                  value={selectedStudentId}
                  onChange={e => setSelectedStudentId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
                >
                  <option value="">Choose a student…</option>
                  {students.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.full_name} — {s.email}
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-gray-400">
                This assigns the sheet directly, without linking it to a lesson. It will appear in the student's Study tab under "Assigned by Your Teacher".
              </p>

              {error && <p className="text-sm text-red-500">{error}</p>}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            {success ? 'Close' : 'Cancel'}
          </button>
          {!success && (
            <button
              onClick={handleAssign}
              disabled={!selectedStudentId || saving}
              className="px-5 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-40"
              style={{ backgroundColor: '#FF8303' }}
            >
              {saving ? 'Assigning…' : 'Assign Sheet'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
