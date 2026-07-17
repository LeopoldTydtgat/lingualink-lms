'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Search, Eye } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

type StudySheet = {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  content: { words?: unknown[]; exercises?: unknown[] } | null
  attachments: unknown[] | null
}

type Props = {
  studentName: string
  lessonId: string
  studentId: string
  alreadyAssigned: string[]
  onClose: () => void
  onSaved: (sheets: { id: string; title: string }[]) => void
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

function isSheetEmpty(sheet: StudySheet, counts: Record<string, number>): boolean {
  const cat = sheet.category?.toLowerCase()
  if (cat === 'vocabulary') return !(sheet.content?.words?.length)
  if (cat === 'grammar') return (counts[sheet.id] ?? 0) === 0
  return false
}

export default function AssignStudySheetsModal({
  studentName,
  lessonId,
  studentId,
  alreadyAssigned,
  onClose,
  onSaved,
}: Props) {
  const supabase = createClient()

  const [sheets, setSheets] = useState<StudySheet[]>([])
  // Per-sheet exercise counts from the exercises table (the grammar empty-gate).
  const [exCounts, setExCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')
  const [selected, setSelected] = useState<Set<string>>(new Set(alreadyAssigned))
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('study_sheets')
        .select('id, title, category, level, difficulty, content, attachments')
        .eq('is_active', true)
        // Homework is student-facing only. Teaching Material (audience='staff') must
        // never be assignable to a student, so restrict this list to active,
        // student-audience, admin-published sheets (owner_id IS NULL). RLS already
        // prevents a teacher-owned row from having audience='student' - this filter
        // is defensive, pinning that contract in code.
        .eq('audience', 'student')
        .is('owner_id', null)
        .order('title')
      setSheets(data ?? [])

      // Grammar "empty" is gated on exercise count, which now lives in the
      // exercises table rather than content.exercises.
      const { data: exRows } = await supabase.from('exercises').select('study_sheet_id')
      const counts: Record<string, number> = {}
      for (const r of exRows ?? []) {
        counts[r.study_sheet_id] = (counts[r.study_sheet_id] ?? 0) + 1
      }
      setExCounts(counts)

      setLoading(false)
    }
    load()
  }, [])

  const filtered = sheets.filter(sheet => {
    const matchesSearch = sheet.title.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = categoryFilter === 'all' || sheet.category === categoryFilter
    const matchesLevel = levelFilter === 'all' || sheet.level === levelFilter
    return matchesSearch && matchesCategory && matchesLevel
  })

  function toggleSheet(id: string, empty: boolean) {
    if (empty) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  async function handleSave() {
    setSaving(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const toRemove = alreadyAssigned.filter(id => !selected.has(id))
    if (toRemove.length > 0) {
      await supabase
        .from('assignments')
        .delete()
        .eq('lesson_id', lessonId)
        .in('study_sheet_id', toRemove)
    }

    const toAdd = Array.from(selected).filter(id => !alreadyAssigned.includes(id))
    if (toAdd.length > 0) {
      await supabase
        .from('assignments')
        .insert(
          toAdd.map(sheetId => ({
            lesson_id: lessonId,
            student_id: studentId,
            study_sheet_id: sheetId,
            assigned_by: user.id,
          }))
        )

      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', user.id)
          .single()

        const addedTitles = sheets
          .filter(s => toAdd.includes(s.id))
          .map(s => s.title)

        await fetch('/api/teacher/notify-homework-assigned', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId,
            teacherName: profile?.full_name ?? 'Your teacher',
            sheetTitles: addedTitles,
          }),
        })
      } catch {
        // email failure is non-blocking
      }
    }

    onSaved(sheets.filter(s => selected.has(s.id)))
    setSaving(false)
    onClose()
  }

  const LEVELS = ['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Assign Study Sheets</h2>
            <p className="text-sm text-gray-500 mt-0.5">{studentName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 py-3 border-b border-gray-100 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search study sheets..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {['all', 'vocabulary', 'grammar'].map(cat => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className="px-3 py-1 rounded-md text-xs border capitalize"
                style={
                  categoryFilter === cat
                    ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                    : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
                }
              >
                {cat}
              </button>
            ))}
            <span className="w-px bg-gray-200 mx-1" />
            {LEVELS.map(l => (
              <button
                key={l}
                onClick={() => setLevelFilter(l)}
                className="px-3 py-1 rounded-md text-xs border"
                style={
                  levelFilter === l
                    ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                    : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
                }
              >
                {l === 'all' ? 'All levels' : l}
              </button>
            ))}
          </div>
        </div>

        {/* Sheet list */}
        <div className="flex-1 overflow-y-auto px-6 py-3 thin-scroll">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No study sheets found.</p>
          ) : (
            <div className="space-y-1">
              {filtered.map(sheet => {
                const empty = isSheetEmpty(sheet, exCounts)
                const isSelected = selected.has(sheet.id)
                return (
                  <div
                    key={sheet.id}
                    onClick={() => toggleSheet(sheet.id, empty)}
                    className="flex items-center gap-4 px-4 py-3 rounded-lg transition-colors"
                    style={{
                      cursor: empty ? 'default' : 'pointer',
                      backgroundColor: empty ? '#f9fafb' : isSelected ? '#FFF3E0' : 'transparent',
                      border: isSelected && !empty ? '1px solid #FF8303' : '1px solid transparent',
                      opacity: empty ? 0.6 : 1,
                    }}
                  >
                    {/* Checkbox */}
                    <div
                      className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0"
                      style={{
                        borderColor: empty ? '#d1d5db' : isSelected ? '#FF8303' : '#d1d5db',
                        backgroundColor: empty ? '#f3f4f6' : isSelected ? '#FF8303' : 'white',
                      }}
                    >
                      {isSelected && !empty && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: empty ? '#9ca3af' : '#111827' }}>
                        {sheet.title}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {sheet.category && (
                          <span className="text-xs text-gray-400 capitalize">{sheet.category}</span>
                        )}
                        {sheet.category && sheet.level && (
                          <span className="text-xs text-gray-300">{String.fromCharCode(183)}</span>
                        )}
                        {sheet.level && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
                          >
                            {sheet.level}
                          </span>
                        )}
                        {!empty && <DifficultyBars count={sheet.difficulty} />}
                        {empty && (
                          <span className="text-xs text-gray-400 italic">No content yet</span>
                        )}
                      </div>
                    </div>

                    {/* Preview link */}
                    <a
                      href={`/study-sheets/${sheet.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="p-1.5 text-gray-300 hover:text-gray-500 transition-colors"
                      title="Preview sheet"
                    >
                      <Eye className="w-4 h-4" />
                    </a>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <span className="text-sm text-gray-500">
            {selected.size} sheet{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
            >
              {saving ? 'Saving...' : 'Save Assignments'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
