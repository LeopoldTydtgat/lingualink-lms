'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Tag as TagIcon } from 'lucide-react'

// -- Types --

export type Tag = {
  id: string
  name: string
  kind: 'topic' | 'skill'
}

type Props = {
  onClose: () => void
  // Fires after any change, so an open sheet form can refresh its picker.
  onSaved?: () => Promise<void>
}

type TagKind = 'topic' | 'skill'

const ORANGE = '#FF8303'

// tags.kind is CHECK-constrained to exactly these two values
// (20260715120000_new345_library_owner_tags_activities.sql).
const KINDS: { value: TagKind; label: string; description: string }[] = [
  { value: 'topic', label: 'Topic', description: 'What the material is about - Travel, Business, Food.' },
  { value: 'skill', label: 'Skill', description: 'What it practises - Listening, Grammar, Writing.' },
]

export function kindPillStyle(kind: string): { backgroundColor: string; color: string } {
  if (kind === 'topic') return { backgroundColor: '#FFF3E0', color: '#FF8303' }
  if (kind === 'skill') return { backgroundColor: '#f3f4f6', color: '#4b5563' }
  return { backgroundColor: '#f3f4f6', color: '#4b5563' }
}

// -- Component --

export default function TagManagerModal({ onClose, onSaved }: Props) {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [name, setName] = useState('')
  const [kind, setKind] = useState<TagKind>('topic')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // tags is service_role write only - every mutation goes through /api/admin/tags.
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)

    try {
      const res = await fetch('/api/admin/tags')
      if (!res.ok) {
        setLoadError(true)
        setTags([])
        setLoading(false)
        return
      }

      const data = await res.json().catch(() => null)
      if (!Array.isArray(data)) {
        setLoadError(true)
        setTags([])
        setLoading(false)
        return
      }

      setTags(data)
      setLoading(false)
    } catch {
      setLoadError(true)
      setTags([])
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Tag name is required.')
      return
    }

    setCreating(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), kind }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // 409 = unique (name, kind) already holds this pair. The DB is the
        // authority on that, so its message is what the admin sees.
        setError(body.error || 'Could not create the tag. Please try again.')
        setCreating(false)
        return
      }

      setName('')
      setCreating(false)
      await load()
      if (onSaved) await onSaved()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    setError(null)

    try {
      const res = await fetch(`/api/admin/tags/${id}`, { method: 'DELETE' })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not delete the tag. Please try again.')
        setDeletingId(null)
        setConfirmDeleteId(null)
        return
      }

      setDeletingId(null)
      setConfirmDeleteId(null)
      await load()
      if (onSaved) await onSaved()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  const topics = tags.filter(t => t.kind === 'topic')
  const skills = tags.filter(t => t.kind === 'skill')

  const renderGroup = (label: string, group: Tag[]) => (
    <div>
      <p className="text-xs font-medium text-gray-400 uppercase mb-2">{label} ({group.length})</p>
      {group.length === 0 ? (
        <div className="py-6 text-center">
          <TagIcon className="w-5 h-5 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-400">None yet.</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {group.map(tag => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full"
              style={kindPillStyle(tag.kind)}
            >
              {tag.name}
              <button
                type="button"
                onClick={() => { setError(null); setConfirmDeleteId(tag.id) }}
                disabled={deletingId === tag.id}
                className="leading-none disabled:opacity-40"
                style={{ opacity: 0.7 }}
                title="Delete tag"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )

  const confirmTag = tags.find(t => t.id === confirmDeleteId)

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      >
        <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
            <h2 className="text-lg font-bold text-gray-900">Manage Tags</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-6 py-5 thin-scroll space-y-6">

            {/* Create */}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New tag</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Travel"
                  maxLength={60}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {KINDS.map(opt => (
                  <label
                    key={opt.value}
                    className="relative flex items-start gap-3 p-3 border-2 rounded-lg cursor-pointer transition-colors"
                    style={{
                      borderColor: kind === opt.value ? '#FF8303' : '#e5e7eb',
                      backgroundColor: kind === opt.value ? '#FF830308' : 'white',
                    }}
                  >
                    <input
                      type="radio"
                      name="tag-kind"
                      value={opt.value}
                      checked={kind === opt.value}
                      onChange={() => setKind(opt.value)}
                      className="sr-only"
                    />
                    {kind === opt.value && (
                      <span
                        className="absolute top-2 right-2 inline-flex items-center justify-center rounded-full"
                        style={{ width: '18px', height: '18px', backgroundColor: '#FF8303' }}
                      >
                        <Check className="w-3 h-3 text-white" />
                      </span>
                    )}
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                className="px-4 py-2 text-sm rounded-md font-medium"
                style={creating || !name.trim()
                  ? { backgroundColor: '#E5E7EB', color: '#9CA3AF' }
                  : { backgroundColor: ORANGE, color: 'white' }}
                onMouseEnter={e => { if (!(creating || !name.trim())) e.currentTarget.style.backgroundColor = '#e67300' }}
                onMouseLeave={e => { if (!(creating || !name.trim())) e.currentTarget.style.backgroundColor = '#FF8303' }}
              >
                {creating ? 'Creating...' : 'Create Tag'}
              </button>

              {error && <p className="text-sm" style={{ color: '#FD5602' }}>{error}</p>}
            </div>

            <div className="border-t border-gray-100" />

            {/* Existing */}
            {loading ? (
              <p className="py-6 text-center text-sm text-gray-400">Loading tags...</p>
            ) : loadError ? (
              <p className="text-sm" style={{ color: '#FD5602' }}>Couldn&apos;t load tags. Close and reopen to try again.</p>
            ) : (
              <div className="space-y-5">
                {renderGroup('Topics', topics)}
                {renderGroup('Skills', skills)}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end px-6 py-4 border-t border-gray-200 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-md border"
              style={{ borderColor: '#E0DFDC', color: '#4b5563', backgroundColor: 'white' }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'white' }}
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
            <h3 className="text-base font-bold text-gray-900 mt-0">Delete Tag?</h3>
            <p className="text-sm text-gray-500">
              {confirmTag ? `"${confirmTag.name}" ` : 'This tag '}
              will be removed from every study sheet that carries it. The sheets themselves are not affected.
            </p>
            <div className="flex gap-2.5 justify-end mt-4">
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={deletingId === confirmDeleteId}
                className="px-4 py-2 text-sm rounded-md border disabled:opacity-50"
                style={{ borderColor: '#D1D5DB', color: '#374151' }}
              >
                Go Back
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deletingId === confirmDeleteId}
                className="px-4 py-2 text-sm rounded-md font-semibold"
                style={deletingId === confirmDeleteId
                  ? { backgroundColor: '#E5E7EB', color: '#9CA3AF' }
                  : { backgroundColor: '#FD5602', color: 'white' }}
              >
                {deletingId === confirmDeleteId ? 'Deleting...' : 'Yes, Delete Tag'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
