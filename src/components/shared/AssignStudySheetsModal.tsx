'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Search, Eye } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

type StudySheet = {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
}

type Props = {
  studentName: string
  lessonId: string
  studentId: string
  alreadyAssigned: string[]
  onClose: () => void
  onSaved: (assignedIds: string[]) => void
}

function ChilliPeppers({ count }: { count: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3].map((i) => (
        <span key={i} style={{ opacity: i <= count ? 1 : 0.2 }}>🌶️</span>
      ))}
    </span>
  )
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
        .select('id, title, category, level, difficulty')
        .eq('is_active', true)
        .order('title')
      setSheets(data ?? [])
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

  function toggleSheet(id: string) {
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
    }

    onSaved(Array.from(selected))
    setSaving(false)
    onClose()
  }

  const LEVELS = ['all', 'A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2']

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
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No study sheets found.</p>
          ) : (
            <div className="space-y-1">
              {filtered.map(sheet => {
                const isSelected = selected.has(sheet.id)
                return (
                  <div
                    key={sheet.id}
                    onClick={() => toggleSheet(sheet.id)}
                    className="flex items-center gap-4 px-4 py-3 rounded-lg cursor-pointer transition-colors"
                    style={{
                      backgroundColor: isSelected ? '#FFF3E0' : 'transparent',
                      border: isSelected ? '1px solid #FF8303' : '1px solid transparent',
                    }}
                  >
                    {/* Checkbox */}
                    <div
                      className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0"
                      style={{
                        borderColor: isSelected ? '#FF8303' : '#d1d5db',
                        backgroundColor: isSelected ? '#FF8303' : 'white',
                      }}
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{sheet.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-500 capitalize">{sheet.category}</span>
                        <span className="text-xs text-gray-300">·</span>
                        <span
                          className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: '#EFF6FF', color: '#3B82F6' }}
                        >
                          {sheet.level}
                        </span>
                        <ChilliPeppers count={sheet.difficulty} />
                      </div>
                    </div>

                    {/* Preview link */}
                    <a
                      href={`/study-sheets/${sheet.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
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
