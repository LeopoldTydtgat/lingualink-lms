'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import SheetFormModal from './SheetFormModal'
import AssignSheetModal from './AssignSheetModal'

// ── Types ─────────────────────────────────────────────────────────────────────

export type WordRow = {
  id: string
  word: string
  pos: string
  definition: string
  example: string
  audio_url: string
}

export type ExerciseRow = {
  id: string
  question: string
  options: [string, string, string, string]
  correct_index: number
  explanation: string
}

export type SheetContent = {
  words?: WordRow[]
  exercises?: ExerciseRow[]
}

export type Attachment = {
  name: string
  url: string
  type: string
}

export type StudySheet = {
  id: string
  title: string
  category: string        // 'vocabulary' | 'grammar'
  level: string           // A1, A1+, A2 … C2
  difficulty: number      // 1 | 2 | 3
  content: SheetContent
  is_active: boolean
  allowed_roles: string[] // ['teacher','teacher_exam'] | ['teacher_exam'] | ['admin']
  intro_text: string | null
  attachments: Attachment[] | null
  created_at: string
  updated_at: string
}

type StudentOption = {
  id: string
  full_name: string
  email: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEVELS = ['A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2']

function rolesToLabel(roles: string[]): string {
  if (!roles || roles.length === 0) return 'All Teachers'
  if (roles.includes('admin') && roles.length === 1) return 'Admin Only'
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return 'Teacher+Exam Only'
  return 'All Teachers'
}

function rolesColor(roles: string[]): string {
  if (!roles || roles.length === 0) return '#16a34a'
  if (roles.includes('admin') && roles.length === 1) return '#6b7280'
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return '#2563eb'
  return '#16a34a'
}

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

function exerciseCount(sheet: StudySheet): number {
  return sheet.content?.exercises?.length ?? 0
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LibraryAdminClient({ adminId }: { adminId: string }) {
  const supabase = createClient()

  // ── Data ──────────────────────────────────────────────────────────────────
  const [sheets, setSheets] = useState<StudySheet[]>([])
  const [students, setStudents] = useState<StudentOption[]>([])
  const [loading, setLoading] = useState(true)

  // ── Filters ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterDifficulty, setFilterDifficulty] = useState('')
  const [filterRoles, setFilterRoles] = useState('')

  // ── Selection (bulk actions) ──────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkRoles, setBulkRoles] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  // ── Modals ────────────────────────────────────────────────────────────────
  const [showForm, setShowForm] = useState(false)
  const [editingSheet, setEditingSheet] = useState<StudySheet | null>(null)
  const [showAssign, setShowAssign] = useState(false)
  const [assigningSheet, setAssigningSheet] = useState<StudySheet | null>(null)

  // ── Delete single ─────────────────────────────────────────────────────────
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // ── Load sheets ───────────────────────────────────────────────────────────
  const loadSheets = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('study_sheets')
      .select('*')
      .order('title', { ascending: true })
    setSheets(data || [])
    setLoading(false)
  }, [])

  // ── Load students (for assign modal) ─────────────────────────────────────
  const loadStudents = useCallback(async () => {
    const { data } = await supabase
      .from('students')
      .select('id, full_name, email')
      .order('full_name')
    setStudents(data || [])
  }, [])

  useEffect(() => {
    loadSheets()
    loadStudents()
  }, [loadSheets, loadStudents])

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = sheets.filter(s => {
    if (search && !s.title.toLowerCase().includes(search.toLowerCase())) return false
    if (filterCategory && s.category !== filterCategory) return false
    if (filterLevel && s.level !== filterLevel) return false
    if (filterDifficulty && s.difficulty !== parseInt(filterDifficulty)) return false
    if (filterRoles) {
      const label = rolesToLabel(s.allowed_roles)
      if (filterRoles === 'all' && label !== 'All Teachers') return false
      if (filterRoles === 'exam' && label !== 'Teacher+Exam Only') return false
      if (filterRoles === 'admin' && label !== 'Admin Only') return false
    }
    return true
  })

  // ── Selection helpers ─────────────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(s => s.id)))
    }
  }

  // ── Bulk change access ────────────────────────────────────────────────────
  const handleBulkChangeAccess = async () => {
    if (!bulkRoles || selectedIds.size === 0) return
    setBulkSaving(true)
    const rolesArray =
      bulkRoles === 'all' ? ['teacher', 'teacher_exam'] :
      bulkRoles === 'exam' ? ['teacher_exam'] :
      ['admin']
    await Promise.all(
      Array.from(selectedIds).map(id =>
        fetch(`/api/admin/library/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowed_roles: rolesArray }),
        })
      )
    )
    setBulkSaving(false)
    setSelectedIds(new Set())
    setBulkRoles('')
    await loadSheets()
  }

  // ── Bulk delete ───────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    await Promise.all(
      Array.from(selectedIds).map(id =>
        fetch(`/api/admin/library/${id}`, { method: 'DELETE' })
      )
    )
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    setSelectedIds(new Set())
    await loadSheets()
  }

  // ── Single delete ─────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    setDeletingId(id)
    await fetch(`/api/admin/library/${id}`, { method: 'DELETE' })
    setDeletingId(null)
    setConfirmDeleteId(null)
    await loadSheets()
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-6xl">

      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Study Library</h1>
        <button
          onClick={() => { setEditingSheet(null); setShowForm(true) }}
          className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white font-medium"
          style={{ backgroundColor: '#FF8303' }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Study Sheet
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <input
          type="text"
          placeholder="Search by title…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 w-56"
        />
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
        >
          <option value="">All Categories</option>
          <option value="vocabulary">Vocabulary</option>
          <option value="grammar">Grammar</option>
        </select>
        <select
          value={filterLevel}
          onChange={e => setFilterLevel(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
        >
          <option value="">All Levels</option>
          {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select
          value={filterDifficulty}
          onChange={e => setFilterDifficulty(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
        >
          <option value="">All Difficulties</option>
          <option value="1">▁ Easy</option>
          <option value="2">▁▂ Medium</option>
          <option value="3">▁▂▃ Hard</option>
        </select>
        <select
          value={filterRoles}
          onChange={e => setFilterRoles(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
        >
          <option value="">All Access</option>
          <option value="all">All Teachers</option>
          <option value="exam">Teacher+Exam Only</option>
          <option value="admin">Admin Only</option>
        </select>
        {(search || filterCategory || filterLevel || filterDifficulty || filterRoles) && (
          <button
            onClick={() => { setSearch(''); setFilterCategory(''); setFilterLevel(''); setFilterDifficulty(''); setFilterRoles('') }}
            className="text-sm text-gray-400 underline"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-sm text-gray-400">
          {filtered.length} {filtered.length === 1 ? 'sheet' : 'sheets'}
        </span>
      </div>

      {/* Bulk action bar — shown when items selected */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-4 mb-4 bg-orange-50 border border-orange-200 rounded-lg px-4 py-3">
          <span className="text-sm font-medium text-gray-700">
            {selectedIds.size} selected
          </span>

          {/* Bulk change access */}
          <select
            value={bulkRoles}
            onChange={e => setBulkRoles(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700"
          >
            <option value="">Change access to…</option>
            <option value="all">All Teachers</option>
            <option value="exam">Teacher+Exam Only</option>
            <option value="admin">Admin Only</option>
          </select>
          <button
            onClick={handleBulkChangeAccess}
            disabled={!bulkRoles || bulkSaving}
            className="px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-40"
            style={{ backgroundColor: '#FF8303' }}
          >
            {bulkSaving ? 'Saving…' : 'Apply'}
          </button>

          <div className="w-px h-5 bg-gray-300" />

          {/* Bulk delete */}
          {!confirmBulkDelete ? (
            <button
              onClick={() => setConfirmBulkDelete(true)}
              className="px-3 py-1.5 text-sm rounded-lg text-white"
              style={{ backgroundColor: '#FD5602' }}
            >
              Delete selected
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600 font-medium">
                Delete {selectedIds.size} sheets? This cannot be undone.
              </span>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-40"
                style={{ backgroundColor: '#FD5602' }}
              >
                {bulkDeleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
              <button onClick={() => setConfirmBulkDelete(false)} className="text-sm text-gray-400 underline">
                Cancel
              </button>
            </div>
          )}

          <button
            onClick={() => { setSelectedIds(new Set()); setConfirmBulkDelete(false) }}
            className="ml-auto text-sm text-gray-400 underline"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-sm text-gray-400">Loading library…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">
          {sheets.length === 0 ? 'No study sheets yet. Click Add Study Sheet to create the first one.' : 'No sheets match the current filters.'}
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">

          {/* Column headers */}
          <div className="grid gap-3 px-5 py-3 text-xs font-medium text-gray-400 uppercase border-b border-gray-100 bg-gray-50"
            style={{ gridTemplateColumns: '2rem 2fr 6rem 5rem 7rem 7rem 5rem auto' }}>
            <input
              type="checkbox"
              checked={filtered.length > 0 && selectedIds.size === filtered.length}
              onChange={toggleSelectAll}
              className="rounded"
            />
            <span>Title</span>
            <span>Category</span>
            <span>Level</span>
            <span>Difficulty</span>
            <span>Access</span>
            <span className="text-center">Exercises</span>
            <span>Actions</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-50">
            {filtered.map(sheet => {
              return (
                <div
                  key={sheet.id}
                  className="grid gap-3 px-5 py-3.5 items-center text-sm"
                  style={{
                    gridTemplateColumns: '2rem 2fr 6rem 5rem 7rem 7rem 5rem auto',
                    backgroundColor: selectedIds.has(sheet.id) ? '#fff9f5' : undefined,
                  }}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selectedIds.has(sheet.id)}
                    onChange={() => toggleSelect(sheet.id)}
                    className="rounded"
                  />

                  {/* Title + intro */}
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">{sheet.title}</p>
                    {sheet.intro_text && (
                      <p className="text-xs text-gray-400 truncate mt-0.5">{sheet.intro_text}</p>
                    )}
                  </div>

                  {/* Category */}
                  <span className="capitalize text-gray-600">{sheet.category}</span>

                  {/* Level */}
                  <span className="font-mono text-gray-700">{sheet.level}</span>

                  {/* Difficulty */}
                  <DifficultyBars count={sheet.difficulty} />

                  {/* Access */}
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full text-white inline-block"
                    style={{ backgroundColor: rolesColor(sheet.allowed_roles) }}
                  >
                    {rolesToLabel(sheet.allowed_roles)}
                  </span>

                  {/* Exercise count */}
                  <span className="text-center text-gray-600">{exerciseCount(sheet)}</span>

                  {/* Actions */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      onClick={() => { setAssigningSheet(sheet); setShowAssign(true) }}
                      className="text-xs underline text-gray-400 hover:text-gray-600"
                    >
                      Assign
                    </button>
                    <button
                      onClick={() => { setEditingSheet(sheet); setShowForm(true) }}
                      className="text-xs underline"
                      style={{ color: '#FF8303' }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(sheet.id)}
                      className="text-xs underline text-red-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Single delete confirmation modal */}
      {confirmDeleteId && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '12px', padding: '28px',
            width: '440px', maxWidth: '90vw',
          }}>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', marginTop: 0 }}>
              Delete Study Sheet?
            </h3>
            <p style={{ fontSize: '14px', color: '#6B7280' }}>
              Are you sure you want to delete this study sheet? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={deletingId === confirmDeleteId}
                style={{
                  padding: '9px 18px', borderRadius: '7px', border: '1px solid #D1D5DB',
                  backgroundColor: 'white', fontSize: '13px',
                  cursor: deletingId === confirmDeleteId ? 'not-allowed' : 'pointer', color: '#374151',
                }}
              >
                Go Back
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deletingId === confirmDeleteId}
                style={{
                  padding: '9px 18px', borderRadius: '7px', border: 'none',
                  backgroundColor: deletingId === confirmDeleteId ? '#E5E7EB' : '#DC2626',
                  color: deletingId === confirmDeleteId ? '#9CA3AF' : 'white',
                  fontSize: '13px', fontWeight: 600,
                  cursor: deletingId === confirmDeleteId ? 'not-allowed' : 'pointer',
                }}
              >
                {deletingId === confirmDeleteId ? 'Deleting...' : 'Yes, Delete Sheet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showForm && (
        <SheetFormModal
          sheet={editingSheet}
          onClose={() => { setShowForm(false); setEditingSheet(null) }}
          onSaved={async () => { setShowForm(false); setEditingSheet(null); await loadSheets() }}
        />
      )}

      {/* Assign modal */}
      {showAssign && assigningSheet && (
        <AssignSheetModal
          sheet={assigningSheet}
          students={students}
          adminId={adminId}
          onClose={() => { setShowAssign(false); setAssigningSheet(null) }}
        />
      )}
    </div>
  )
}
