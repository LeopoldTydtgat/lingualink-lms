'use client'

import { useCallback, useEffect, useState } from 'react'
import ActivityFormModal from './ActivityFormModal'

// ── Types ─────────────────────────────────────────────────────────────────────

type ActivityType = 'mcq' | 'writing_task'

type Props = {
  sheetId: string
  sheetTitle: string
  onClose: () => void
}

// Exactly the columns the admin list route returns — no answer_key.
type ActivityRow = {
  id: string
  position: number
  type: string
  title: string | null
  content: { questions?: unknown[] } | null
  updated_at: string
}

const ORANGE = '#FF8303'

// ── Helpers ───────────────────────────────────────────────────────────────────

function questionCount(activity: ActivityRow): number {
  const questions = activity.content?.questions
  return Array.isArray(questions) ? questions.length : 0
}

// Human label for the row's stored type. Writing tasks have no auto-graded
// questions, so their "Questions" cell shows a dash rather than 0.
function typeLabel(type: string): string {
  if (type === 'writing_task') return 'Writing task'
  if (type === 'mcq') return 'MCQ'
  return type
}

// Date only, built from the Date object's local getters. Deliberately avoids
// toLocaleDateString/toLocaleTimeString (banned in components that can render on
// both server and client) and toISOString (never used for local dates here).
function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ActivitiesModal({ sheetId, sheetTitle, onClose }: Props) {
  const [activities, setActivities] = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Only meaningful when opening the form in create mode (editingId === null):
  // the activity type chosen in the add-activity flow.
  const [createType, setCreateType] = useState<ActivityType>('mcq')
  // Toggles the inline type picker under the list.
  const [showTypeMenu, setShowTypeMenu] = useState(false)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Every read goes through the admin route: activities are service_role writes
  // only, and the list route is the surface that omits answer_key.
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)

    try {
      const res = await fetch(`/api/admin/library/${sheetId}/activities`)
      if (!res.ok) {
        setLoadError(true)
        setActivities([])
        setLoading(false)
        return
      }

      const data = await res.json().catch(() => null)
      if (!Array.isArray(data)) {
        setLoadError(true)
        setActivities([])
        setLoading(false)
        return
      }

      setActivities(data)
      setLoading(false)
    } catch {
      setLoadError(true)
      setActivities([])
      setLoading(false)
    }
  }, [sheetId])

  useEffect(() => { load() }, [load])

  const openCreate = (type: ActivityType) => {
    setCreateType(type)
    setEditingId(null)
    setShowTypeMenu(false)
    setShowForm(true)
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    setDeleteError(null)

    try {
      const res = await fetch(`/api/admin/library/${sheetId}/activities/${id}`, { method: 'DELETE' })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // 409 = the activity has student attempts, which the route refuses to
        // cascade away. Surfaced as-is: it is an explanation, not a failure.
        setDeleteError(body.error || 'Could not delete the activity. Please try again.')
        setDeletingId(null)
        setConfirmDeleteId(null)
        return
      }

      setDeletingId(null)
      setConfirmDeleteId(null)
      await load()
    } catch {
      setDeleteError('Could not reach the server. Check your connection and try again.')
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      >
        <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-gray-900">Activities</h2>
              <p className="text-xs text-gray-400 truncate mt-0.5">{sheetTitle}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none flex-shrink-0">✕</button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-6 py-5 thin-scroll">
            {deleteError && (
              <p className="text-sm mb-4" style={{ color: '#FD5602' }}>{deleteError}</p>
            )}

            {loading ? (
              <p className="text-sm text-gray-400">Loading activities…</p>
            ) : loadError ? (
              <p className="text-sm" style={{ color: '#FD5602' }}>
                Couldn&apos;t load this sheet&apos;s activities. Close and reopen to try again.
              </p>
            ) : activities.length === 0 ? (
              <p className="text-sm text-gray-400">
                No activities yet. Click Add Activity to create the first one.
              </p>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Column headers */}
                <div
                  className="grid gap-3 px-4 py-2.5 text-xs font-medium text-gray-400 uppercase border-b border-gray-100 bg-gray-50"
                  style={{ gridTemplateColumns: '46% 14% 18% 22%' }}
                >
                  <span>Title</span>
                  <span className="text-center">Questions</span>
                  <span>Updated</span>
                  <span>Actions</span>
                </div>

                <div className="divide-y divide-gray-50">
                  {activities.map(activity => (
                    <div
                      key={activity.id}
                      className="grid gap-3 px-4 py-3 items-center text-sm"
                      style={{ gridTemplateColumns: '46% 14% 18% 22%' }}
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">
                          {activity.title || 'Untitled activity'}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">{typeLabel(activity.type)}</p>
                      </div>

                      <span className="text-center text-gray-600">
                        {activity.type === 'mcq' ? questionCount(activity) : '—'}
                      </span>

                      <span className="text-gray-500 text-xs">{formatUpdated(activity.updated_at)}</span>

                      <div className="flex items-center gap-4">
                        <button
                          onClick={() => { setEditingId(activity.id); setShowForm(true) }}
                          className="text-xs"
                          style={{ color: ORANGE }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => { setDeleteError(null); setConfirmDeleteId(activity.id) }}
                          className="text-xs"
                          style={{ color: '#FD5602' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#e04e02' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#FD5602' }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add — hidden while the list is unknown, so nothing is authored blind */}
            {!loading && !loadError && (
              showTypeMenu ? (
                <div className="mt-4 rounded-lg border-2 border-dashed border-gray-300 p-3 space-y-2">
                  <p className="text-xs font-medium text-gray-400 uppercase px-1">Choose activity type</p>
                  <button
                    type="button"
                    onClick={() => openCreate('mcq')}
                    className="w-full text-left rounded-lg border border-gray-200 px-4 py-2.5"
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#FFD9A8' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb' }}
                  >
                    <span className="block text-sm font-medium text-gray-900">Multiple choice</span>
                    <span className="block text-xs text-gray-400 mt-0.5">Auto-graded questions, each with a set of options.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openCreate('writing_task')}
                    className="w-full text-left rounded-lg border border-gray-200 px-4 py-2.5"
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#FFD9A8' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb' }}
                  >
                    <span className="block text-sm font-medium text-gray-900">Writing task</span>
                    <span className="block text-xs text-gray-400 mt-0.5">A free-text prompt the student writes a response to. Not auto-graded.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTypeMenu(false)}
                    className="text-xs text-gray-400 hover:text-gray-600 px-1 pt-0.5"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowTypeMenu(true)}
                  className="mt-4 flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 w-full justify-center"
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#FFD9A8'; e.currentTarget.style.color = '#FF8303' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#6b7280' }}
                >
                  + Add Activity
                </button>
              )
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end px-6 py-4 border-t border-gray-200 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md"
              style={{ border: '1px solid #E0DFDC', color: '#4b5563' }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 60 }}
        >
          <div className="bg-white rounded-xl p-7" style={{ width: '440px', maxWidth: '90vw' }}>
            <h3 className="text-base font-bold text-gray-900 mt-0">Delete Activity?</h3>
            <p className="text-sm text-gray-500">
              Are you sure you want to delete this activity? This cannot be undone.
            </p>
            <div className="flex gap-2.5 justify-end mt-4">
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={deletingId === confirmDeleteId}
                className="px-4 py-2 text-sm rounded-md disabled:opacity-50"
                style={{ border: '1px solid #E0DFDC', color: '#4b5563' }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
              >
                Go Back
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deletingId === confirmDeleteId}
                className="px-4 py-2 text-sm rounded-md text-white font-semibold"
                style={
                  deletingId === confirmDeleteId
                    ? { backgroundColor: '#E5E7EB', color: '#9CA3AF' }
                    : { backgroundColor: '#FD5602' }
                }
              >
                {deletingId === confirmDeleteId ? 'Deleting…' : 'Yes, Delete Activity'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit activity */}
      {showForm && (
        <ActivityFormModal
          sheetId={sheetId}
          activityId={editingId}
          createType={createType}
          onClose={() => { setShowForm(false); setEditingId(null) }}
          onSaved={async () => { setShowForm(false); setEditingId(null); await load() }}
        />
      )}
    </>
  )
}
