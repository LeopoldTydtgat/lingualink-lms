'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import DifficultyBars from '@/components/study/DifficultyBars'
import { fileTypeLabel } from '@/lib/study/fileTypeLabel'
import { Tag, Plus, BookOpen, ClipboardCheck, Lock, Layers, Search, MoreHorizontal, FileText } from 'lucide-react'
import SheetFormModal from './SheetFormModal'
import AssignSheetModal from './AssignSheetModal'
import ActivitiesModal from './ActivitiesModal'
import TagManagerModal from './TagManagerModal'

// -- Types --

export type WordRow = {
  id: string
  word: string
  pos: string
  definition: string
  example: string
  audio_url: string
}

export type SheetContent = {
  words?: WordRow[]
}

export type Attachment = {
  name: string
  url?: string
  type: string
}

export type StudySheet = {
  id: string
  title: string
  // Stored lowercase: 'vocabulary' | 'grammar' | 'listening' | 'reading'. NULL on
  // teaching material and on teacher private resources — the column is
  // nullable and its CHECK passes on NULL.
  category: string | null
  level: string | null    // A1, A2 ... C2; null for teacher private resources
  difficulty: number      // 1 | 2 | 3
  content: SheetContent
  is_active: boolean
  allowed_roles: string[] // ['teacher','teacher_exam'] | ['teacher_exam'] | ['admin']
  intro_text: string | null
  attachments: Attachment[] | null
  // Bodies of the listening/reading categories (S549). Optional: not every
  // caller-shaped row carries them, and an absent value reads as "none".
  links?: unknown[] | null
  reading_text?: string | null
  // study_sheets.audience — 'student' (a study sheet) or 'staff' (teaching
  // material). Optional here so no existing object literal typed as StudySheet
  // has to change; isMaterial() below reads it in the fail-safe direction.
  audience?: string | null
  created_at: string
  updated_at: string
}

type StudentOption = {
  id: string
  full_name: string
  email: string
}

// The list mixes student-facing study sheets with staff teaching material
// (files/PDFs). '' shows both.
type SheetTypeFilter = '' | 'sheet' | 'material'

// -- Helpers --

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

// Shared by the table header and its rows — they must never drift apart.
//
// Fixed px columns plus one flexible Title track: the model of the working grid
// in (admin)/admin/classes/ClassesListClient.tsx, which pairs fixed px with fr
// and no gap. The track list here was previously eight PERCENTAGES summing to
// exactly 100%, applied with gap-3 — and CSS Grid resolves percentage tracks
// against the content box and then ADDS the gaps on top, so the grid ran ~79px
// wider than its container and the card's overflow-hidden clipped ~60px off the
// right edge at EVERY viewport width. The Actions column was the casualty:
// below a ~1720px viewport the kebab sat outside the clip and could not be
// clicked at all.
//
// Three rules keep that from coming back:
//   1. There is no grid gap. Column spacing lives INSIDE each cell as CELL_PAD,
//      which cannot widen the grid however many columns there are.
//   2. The Title track is minmax(0, 1fr), not 1fr. A bare 1fr floors at the
//      cell's min-content, so a narrow viewport would push the fixed columns off
//      the end again; minmax(0, ...) lets it shrink instead.
//   3. The fixed columns are minmax(0, Npx), not Npx. Once Title has collapsed
//      to 0 — below a ~419px viewport, where the sidebar is already hidden —
//      bare px tracks would overflow the card and clip the kebab all over again,
//      the original defect relocated to phone widths. With a 0 minimum they
//      share out whatever is left instead, so the grid CANNOT overflow at any
//      width. At any width where the tracks fit (~419px up) each one reaches its
//      max and this is a no-op.
//
// Sizing at 1366px: html is 15px (globals.css), so the two w-56 rails are 210px
// each, NOT 224 — main 946, less the 4px thin-scroll bar, the page's 45px p-6,
// the card's 2px border and the row's 37.5px px-5, leaves an 857px grid content
// box. The fixed columns take 330px of it and Title gets the ~527px balance.
const GRID_COLUMNS = '30px minmax(0, 1fr) minmax(0, 160px) minmax(0, 140px)'

// Column spacing, applied as padding INSIDE the cell rather than as a grid gap
// (see above). Shared by the header and the rows so the two can never drift
// apart. The last column (Actions) takes none — the row's own px-5 is its right
// margin — and neither does the checkbox, whose 30px track already leaves a
// 17px gutter beside a ~13px control.
const CELL_PAD = { paddingRight: '12px' }

function rolesToLabel(roles: string[]): string {
  if (!roles || roles.length === 0) return 'All Teachers'
  if (roles.includes('admin') && roles.length === 1) return 'Admin Only'
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return 'Teacher+Exam Only'
  return 'All Teachers'
}

function rolesPillStyle(roles: string[]): { backgroundColor: string; color: string } {
  if (!roles || roles.length === 0) return { backgroundColor: '#f3f4f6', color: '#4b5563' }
  if (roles.includes('admin') && roles.length === 1) return { backgroundColor: '#FFF3E0', color: '#FF8303' }
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return { backgroundColor: '#FFF3E0', color: '#FF8303' }
  return { backgroundColor: '#f3f4f6', color: '#4b5563' }
}

// study_sheets.audience is NOT NULL and defaults to 'staff', and both write
// routes coerce anything that is not exactly 'student' to 'staff'. So only an
// explicit 'student' is a study sheet; every other value — including one missing
// from an older-shaped row — reads as staff teaching material. That is the
// fail-safe direction: an unlabelled row is never treated as student-facing.
function isMaterial(sheet: StudySheet): boolean {
  return sheet.audience !== 'student'
}

// The sheet's files, each paired with its ORIGINAL index in
// study_sheets.attachments. /api/library-file/[sheetId]/[index] resolves the
// attachment POSITIONALLY (attachments[idx] in that route), so this must not
// reindex: dropping a malformed entry and renumbering the rest would hand the
// admin a link that opens the wrong file.
function sheetFiles(sheet: StudySheet): { att: Attachment; idx: number }[] {
  const raw: unknown[] = Array.isArray(sheet.attachments) ? sheet.attachments : []
  const out: { att: Attachment; idx: number }[] = []
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    const att = entry as Attachment
    if (typeof att.name !== 'string' || att.name.length === 0) return
    out.push({ att, idx })
  })
  return out
}

// fileTypeLabel reads the mime string directly, and a malformed attachment row
// can carry none. Coerced to '' here (which the label's own fallback turns into
// 'FILE') rather than reaching .includes() as undefined and throwing mid-render.
function attLabel(att: Attachment): string {
  return fileTypeLabel(typeof att.type === 'string' ? att.type : '')
}

// A sheet is empty (non-assignable) only when it has zero content words, zero
// activities, zero links AND no reading text. links and reading_text now count
// as content (listening/reading categories, S549) — a listening sheet that is
// nothing but links, or a reading sheet that is nothing but its passage, is a
// complete sheet and must be assignable. Category still does not factor in, and
// attachments still do not count as content — attachment-only sheets stay
// teaching material. This also keeps activities-only sheets unlocked (S318).
function isSheetEmpty(sheet: StudySheet, counts: Record<string, number>): boolean {
  return (
    !(sheet.content?.words?.length) &&
    (counts[sheet.id] ?? 0) === 0 &&
    !(sheet.links?.length) &&
    !(sheet.reading_text?.trim())
  )
}

// Teacher-portal StatCard anatomy: 32px tinted icon square + label, big value,
// muted caption. Palette locked to inline styles (Tailwind v4 dynamic-class rule).
function StatCard({
  icon: Icon,
  label,
  value,
  caption,
  unknown = false,
}: {
  icon: typeof BookOpen
  label: string
  value: number
  caption: string
  // True when the underlying data failed to load. A count of 0 is a claim the
  // data does not support, so a neutral placeholder is shown instead.
  unknown?: boolean
}) {
  return (
    <div className="flex-1 min-w-[200px] rounded-xl p-5 shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6' }}>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: '32px', height: '32px', backgroundColor: '#FFF3E0' }}
        >
          <Icon className="w-4 h-4" style={{ color: '#FF8303' }} />
        </span>
        <span className="text-sm font-medium" style={{ color: '#4b5563' }}>{label}</span>
      </div>
      {unknown ? (
        <p className="text-3xl font-semibold" style={{ color: '#9ca3af' }}>—</p>
      ) : (
        <p className="text-3xl font-semibold" style={{ color: '#111827' }}>{value}</p>
      )}
      <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{caption}</p>
    </div>
  )
}

// -- Component --

export default function LibraryAdminClient({ adminId }: { adminId: string }) {
  const supabase = createClient()

  // -- Data --
  const [sheets, setSheets] = useState<StudySheet[]>([])
  // Per-sheet activity counts sourced from the activities table (not content).
  const [actCounts, setActCounts] = useState<Record<string, number>>({})
  const [students, setStudents] = useState<StudentOption[]>([])
  const [loading, setLoading] = useState(true)
  // Set when either library query fails. Without it a failed read renders as an
  // empty library: the admin would be told to create the first sheet while the
  // real ones are still there, and every activity count would read 0 — which
  // also disables Assign on sheets that do have content.
  const [loadError, setLoadError] = useState(false)
  // Same hazard on the students list: an empty dropdown reads as "no students".
  const [studentsError, setStudentsError] = useState(false)

  // -- Filters --
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<SheetTypeFilter>('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterDifficulty, setFilterDifficulty] = useState('')
  const [filterRoles, setFilterRoles] = useState('')

  // -- Selection (bulk actions) --
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkRoles, setBulkRoles] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // Each PATCH is independent, so an access change can land on some sheets and
  // not others. The reloaded pills show which — this says how many.
  const [bulkAccessError, setBulkAccessError] = useState<string | null>(null)

  // -- Row action menu (kebab) --
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // -- Modals --
  const [showForm, setShowForm] = useState(false)
  const [editingSheet, setEditingSheet] = useState<StudySheet | null>(null)
  const [showAssign, setShowAssign] = useState(false)
  const [assigningSheet, setAssigningSheet] = useState<StudySheet | null>(null)
  const [activitiesSheet, setActivitiesSheet] = useState<StudySheet | null>(null)
  const [showTagManager, setShowTagManager] = useState(false)

  // -- Delete single --
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // The delete route can now fail loudly (NEW364: a sheet whose files cannot be
  // cleaned out of storage is NOT deleted). Silently reloading the list would
  // show the sheet still sitting there with no explanation.
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // -- Load sheets --
  const loadSheets = useCallback(async () => {
    setLoading(true)
    setLoadError(false)

    try {
      const { data, error } = await supabase
        .from('study_sheets')
        .select('*')
        .order('title', { ascending: true })

      if (error) {
        setSheets([])
        setActCounts({})
        setLoadError(true)
        return null
      }

      setSheets(data || [])

      // Activity counts come from the activities table — content.exercises is no
      // longer written. One lightweight query, reduced to a per-sheet count map.
      // Select only id, sheet_id — never content/answer_key (column-level grants).
      const { data: actRows, error: actError } = await supabase.from('activities').select('id, sheet_id')

      if (actError) {
        // Counts drive isSheetEmpty — which is what disables Assign — and the
        // Total Activities card. An unknown count must not be rendered as zero,
        // so the whole list is withheld.
        setActCounts({})
        setLoadError(true)
        return data || []
      }

      const counts: Record<string, number> = {}
      for (const r of actRows ?? []) {
        counts[r.sheet_id] = (counts[r.sheet_id] ?? 0) + 1
      }
      setActCounts(counts)
      return data || []
    } finally {
      setLoading(false)
    }
  }, [])

  // -- Load students (for assign modal) --
  const loadStudents = useCallback(async () => {
    const { data, error } = await supabase
      .from('students')
      .select('id, full_name, email')
      .order('full_name')

    if (error) {
      setStudents([])
      setStudentsError(true)
      return
    }

    setStudentsError(false)
    setStudents(data || [])
  }, [])

  useEffect(() => {
    loadSheets()
    loadStudents()
  }, [loadSheets, loadStudents])

  // Close the row action menu on any outside click.
  useEffect(() => {
    if (!openMenuId) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuId])

  // Files & PDFs hides the Category and Difficulty selects (neither means
  // anything on a file), so it must CLEAR them in the same step. A filter still
  // being applied while its control is off screen silently removes rows with no
  // visible reason — which is the defect this filter exists to fix.
  const selectFilterType = (next: SheetTypeFilter) => {
    setFilterType(next)
    if (next === 'material') {
      setFilterCategory('')
      setFilterDifficulty('')
    }
  }

  // -- Filtered list --
  const filtered = sheets.filter(s => {
    if (search && !s.title.toLowerCase().includes(search.toLowerCase())) return false
    if (filterType === 'material' && !isMaterial(s)) return false
    if (filterType === 'sheet' && isMaterial(s)) return false
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

  // -- Selection helpers --
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // -- Bulk change access --
  const handleBulkChangeAccess = async () => {
    if (!bulkRoles || selectedIds.size === 0) return
    setBulkSaving(true)
    setBulkAccessError(null)

    const rolesArray =
      bulkRoles === 'all' ? ['teacher', 'teacher_exam'] :
      bulkRoles === 'exam' ? ['teacher_exam'] :
      ['admin']

    const ids = Array.from(selectedIds)

    try {
      const results = await Promise.all(
        ids.map(id =>
          fetch(`/api/admin/library/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowed_roles: rolesArray }),
          })
            .then(res => res.ok)
            .catch(() => false)
        )
      )

      const failed = results.filter(ok => !ok).length

      if (failed > 0) {
        // The selection is the only record of which sheets were targeted, so it
        // stays put — clearing it would leave the admin nothing to retry from.
        setBulkAccessError(
          `${failed} of ${ids.length} ${ids.length === 1 ? 'sheet' : 'sheets'} could not be updated and ${failed === 1 ? 'still has' : 'still have'} the old access. The selection is kept so you can try again.`
        )
      } else {
        toast.success(`Access updated for ${ids.length} ${ids.length === 1 ? 'sheet' : 'sheets'}.`)
        setSelectedIds(new Set())
        setBulkRoles('')
      }

      await loadSheets()
    } finally {
      setBulkSaving(false)
    }
  }

  // -- Bulk delete --
  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    setDeleteError(null)

    const ids = Array.from(selectedIds)

    try {
      const results = await Promise.all(
        ids.map(id =>
          fetch(`/api/admin/library/${id}`, { method: 'DELETE' })
            .then(res => res.ok)
            .catch(() => false)
        )
      )

      const failed = results.filter(ok => !ok).length

      // Partial failure is real: each sheet is deleted independently, so some can
      // survive. The reloaded list shows which — this says how many, and why to look.
      if (failed > 0) {
        setDeleteError(
          `${failed} of ${ids.length} ${ids.length === 1 ? 'sheet' : 'sheets'} could not be deleted and ${failed === 1 ? 'is' : 'are'} still listed. Try again, or delete them one at a time to see why.`
        )
      }

      const reloaded = await loadSheets()

      if (failed > 0) {
        if (reloaded === null) {
          // The reload itself failed — we have no reliable view of what survived,
          // so the selection is left untouched rather than wrongly cleared.
        } else {
          // Trust the reloaded list, not the per-request ok flags — a sheet can be
          // gone server-side even if its DELETE response looked like a failure.
          // Intersecting keeps only ids that genuinely survived, so a retry can't
          // re-issue DELETE for rows already gone.
          const survivingIds = new Set(reloaded.map(s => s.id))
          setSelectedIds(prev => new Set(Array.from(prev).filter(id => survivingIds.has(id))))
        }
      } else {
        toast.success(`${ids.length} ${ids.length === 1 ? 'sheet' : 'sheets'} deleted.`)
        setSelectedIds(new Set())
      }
    } finally {
      setBulkDeleting(false)
      setConfirmBulkDelete(false)
    }
  }

  // -- Single delete --
  const handleDelete = async (id: string) => {
    setDeletingId(id)
    setDeleteError(null)

    try {
      const res = await fetch(`/api/admin/library/${id}`, { method: 'DELETE' })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setDeleteError(body.error || 'Could not delete the sheet. Please try again.')
      } else {
        toast.success('Sheet deleted.')
      }
    } catch {
      // Without this the confirmation modal wedges at "Deleting..." with both of
      // its buttons disabled and no way out.
      setDeleteError('Could not reach the server, so the sheet was not deleted. Check your connection and try again.')
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }

    await loadSheets()
  }

  const selectStyle = { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#4b5563' }

  // -- Render --
  return (
    <div className="p-6 space-y-6">

      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#111827' }}>Lesson Library</h1>
          <p className="text-sm mt-1" style={{ color: '#4b5563' }}>Manage the shared library of lesson materials</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTagManager(true)}
            className="inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md"
            style={{ backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#FFE4C4')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FFF0E0')}
          >
            <Tag className="w-4 h-4" />
            Manage Tags
          </button>
          <button
            onClick={() => { setEditingSheet(null); setShowForm(true) }}
            className="inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md text-white"
            style={{ backgroundColor: '#FF8303' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
          >
            <Plus className="w-4 h-4" />
            Add Sheet
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="flex flex-wrap gap-4">
        <StatCard icon={BookOpen} label="Total Sheets" value={sheets.length} caption="In the shared library" unknown={loadError} />
        <StatCard icon={ClipboardCheck} label="Assignable" value={sheets.filter(s => !isSheetEmpty(s, actCounts)).length} caption="Have content or activities" unknown={loadError} />
        <StatCard icon={Lock} label="Admin Only" value={sheets.filter(s => s.allowed_roles?.length === 1 && s.allowed_roles.includes('admin')).length} caption="Hidden from teachers" unknown={loadError} />
        <StatCard icon={Layers} label="Total Activities" value={Object.values(actCounts).reduce((a, b) => a + b, 0)} caption="Across all sheets" unknown={loadError} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9ca3af' }} />
          <input
            type="text"
            placeholder="Search by title..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border rounded-md pl-9 pr-3 py-2 text-sm w-full"
            style={selectStyle}
          />
        </div>
        <select
          value={filterType}
          onChange={e => selectFilterType(e.target.value as SheetTypeFilter)}
          className="px-3 py-2 rounded-md text-sm border"
          style={selectStyle}
        >
          <option value="">All types</option>
          <option value="sheet">Study sheets</option>
          <option value="material">Files &amp; PDFs</option>
        </select>
        {filterType !== 'material' && (
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="px-3 py-2 rounded-md text-sm border"
            style={selectStyle}
          >
            <option value="">All Categories</option>
            <option value="vocabulary">Vocabulary</option>
            <option value="grammar">Grammar</option>
            <option value="listening">Listening</option>
            <option value="reading">Reading</option>
          </select>
        )}
        <select
          value={filterLevel}
          onChange={e => setFilterLevel(e.target.value)}
          className="px-3 py-2 rounded-md text-sm border"
          style={selectStyle}
        >
          <option value="">All Levels</option>
          {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        {filterType !== 'material' && (
          <select
            value={filterDifficulty}
            onChange={e => setFilterDifficulty(e.target.value)}
            className="px-3 py-2 rounded-md text-sm border"
            style={selectStyle}
          >
            <option value="">All Difficulties</option>
            <option value="1">Easy</option>
            <option value="2">Medium</option>
            <option value="3">Hard</option>
          </select>
        )}
        <select
          value={filterRoles}
          onChange={e => setFilterRoles(e.target.value)}
          className="px-3 py-2 rounded-md text-sm border"
          style={selectStyle}
        >
          <option value="">All Access</option>
          <option value="all">All Teachers</option>
          <option value="exam">Teacher+Exam Only</option>
          <option value="admin">Admin Only</option>
        </select>
        {(search || filterType || filterCategory || filterLevel || filterDifficulty || filterRoles) && (
          <button
            onClick={() => { setSearch(''); setFilterType(''); setFilterCategory(''); setFilterLevel(''); setFilterDifficulty(''); setFilterRoles('') }}
            className="text-sm font-medium"
            style={{ color: '#FF8303' }}
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-sm text-gray-400">
          {filtered.length} {filtered.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      {/* Delete failure — the sheet(s) below are still real */}
      {deleteError && (
        <div
          className="mb-4 rounded-xl px-4 py-3 flex items-start gap-3"
          style={{ border: '1px solid #f3f4f6', borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6' }}
        >
          <p className="text-sm text-red-700 flex-1">{deleteError}</p>
          <button
            onClick={() => setDeleteError(null)}
            className="text-red-400 hover:text-red-600 text-sm leading-none flex-shrink-0"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Bulk access-change failure — the pills below are still the old ones */}
      {bulkAccessError && (
        <div
          className="mb-4 rounded-xl px-4 py-3 flex items-start gap-3"
          style={{ border: '1px solid #f3f4f6', borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6' }}
        >
          <p className="text-sm text-red-700 flex-1">{bulkAccessError}</p>
          <button
            onClick={() => setBulkAccessError(null)}
            className="text-red-400 hover:text-red-600 text-sm leading-none flex-shrink-0"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Bulk action bar — shown when items selected */}
      {selectedIds.size > 0 && (
        <div
          className="flex items-center gap-4 mb-4 rounded-lg px-4 py-3"
          style={{ border: '1px solid #FFD9A8', backgroundColor: '#FFF0E0' }}
        >
          <span className="text-sm font-medium text-gray-700">
            {selectedIds.size} selected
          </span>

          {/* Bulk change access */}
          <select
            value={bulkRoles}
            onChange={e => setBulkRoles(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-700"
          >
            <option value="">Change access to…</option>
            <option value="all">All Teachers</option>
            <option value="exam">Teacher+Exam Only</option>
            <option value="admin">Admin Only</option>
          </select>
          <button
            onClick={handleBulkChangeAccess}
            disabled={!bulkRoles || bulkSaving}
            className="px-3 py-1.5 text-sm font-medium rounded-md disabled:opacity-40"
            style={{ backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FF8303' }}
          >
            {bulkSaving ? 'Saving…' : 'Apply'}
          </button>

          <div className="w-px h-5 bg-gray-300" />

          {/* Bulk delete */}
          {!confirmBulkDelete ? (
            <button
              onClick={() => setConfirmBulkDelete(true)}
              className="px-3 py-1.5 text-sm font-medium rounded-md text-white"
              style={{ backgroundColor: '#FD5602' }}
            >
              Delete selected
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600 font-medium">
                Delete {selectedIds.size} items? This cannot be undone.
              </span>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="px-3 py-1.5 text-sm font-medium rounded-md text-white disabled:opacity-40"
                style={{ backgroundColor: '#FD5602' }}
              >
                {bulkDeleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
              <button
                onClick={() => setConfirmBulkDelete(false)}
                className="text-sm font-medium"
                style={{ color: '#6b7280' }}
              >
                Cancel
              </button>
            </div>
          )}

          <button
            onClick={() => { setSelectedIds(new Set()); setConfirmBulkDelete(false) }}
            className="ml-auto text-sm font-medium"
            style={{ color: '#6b7280' }}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="rounded-xl px-6 py-12 text-center text-sm shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', color: '#9ca3af' }}>
          Loading library…
        </div>
      ) : loadError ? (
        <div
          className="rounded-xl px-6 py-12 text-center text-sm shadow-sm"
          style={{ border: '1px solid #f3f4f6', borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6', color: '#FD5602' }}
        >
          <p className="font-medium">Couldn&apos;t load the library.</p>
          <p className="mt-1">
            This is not an empty library — the sheets are still there. Refresh the page to try again.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl px-6 py-12 text-center text-sm shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', color: '#9ca3af' }}>
          {sheets.length === 0 ? 'Nothing in the library yet. Click Add Sheet to create the first item.' : 'No items match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f3f4f6' }}>

          {/* Column headers — no grid gap, see GRID_COLUMNS */}
          <div className="grid px-5 py-3 text-xs font-medium uppercase tracking-wide"
            style={{ gridTemplateColumns: GRID_COLUMNS, backgroundColor: '#f9fafb', borderBottom: '1px solid #f3f4f6', color: '#9ca3af' }}>
            <span />
            <span style={CELL_PAD}>Title</span>
            <span style={CELL_PAD}>Access</span>
            <span>Actions</span>
          </div>

          {/* Rows */}
          <div>
            {filtered.map((sheet, idx) => {
              const empty = isSheetEmpty(sheet, actCounts)
              const material = isMaterial(sheet)
              const files = sheetFiles(sheet)
              return (
                <div
                  key={sheet.id}
                  className="grid px-5 py-4 items-center text-sm"
                  style={{
                    gridTemplateColumns: GRID_COLUMNS,
                    borderBottom: '1px solid #f3f4f6',
                    backgroundColor: selectedIds.has(sheet.id) ? '#fff9f5' : undefined,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = selectedIds.has(sheet.id) ? '#fff9f5' : 'transparent')}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selectedIds.has(sheet.id)}
                    onChange={() => toggleSelect(sheet.id)}
                    className="rounded"
                    style={{ accentColor: '#FF8303' }}
                  />

                  {/* Icon tile + title + badge line + intro. overflow-hidden so that
                      once the Title track has collapsed at phone widths its contents
                      clip at the cell edge instead of running over the Access column. */}
                  <div className="flex items-center gap-3 min-w-0 overflow-hidden" style={CELL_PAD}>
                    <span
                      className="flex items-center justify-center rounded-lg flex-shrink-0"
                      style={{ width: '40px', height: '40px', backgroundColor: material ? '#f3f4f6' : '#FFF3E0' }}
                    >
                      {material
                        ? <FileText className="w-5 h-5" style={{ color: '#4b5563' }} />
                        : <BookOpen className="w-5 h-5" style={{ color: '#FF8303' }} />}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate" title={sheet.title}>{sheet.title}</p>
                      {/* What this row IS, at a glance: a study sheet, or the file type
                          of the material's first file ('File' when it carries none) —
                          followed by category, level and difficulty, which used to hold
                          columns of their own. All three stay filterable from the
                          dropdowns above, and difficulty is here so that filtering by it
                          cannot hide rows with nothing on screen to explain why. A value
                          the sheet does not carry renders nothing at all, rather than the
                          placeholder dash the old Category column showed; difficulty is
                          skipped on material rows, where the old column was blank too.
                          flex-wrap, so a narrow viewport stacks these instead of
                          pushing them out of the cell. */}
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-medium"
                          style={material
                            ? { backgroundColor: '#f3f4f6', color: '#4b5563' }
                            : { backgroundColor: '#FFF3E0', color: '#FF8303' }}
                        >
                          {material
                            ? (files.length > 0 ? attLabel(files[0].att) : 'File')
                            : 'Study sheet'}
                        </span>
                        {sheet.category && (
                          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium capitalize" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>
                            {sheet.category}
                          </span>
                        )}
                        {sheet.level && (
                          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>
                            {sheet.level}
                          </span>
                        )}
                        {!material && (
                          <span
                            className="inline-flex"
                            title={
                              sheet.difficulty === 1 ? 'Easy'
                                : sheet.difficulty === 2 ? 'Medium'
                                : sheet.difficulty === 3 ? 'Hard'
                                : undefined
                            }
                          >
                            <DifficultyBars count={sheet.difficulty} />
                          </span>
                        )}
                      </div>
                      {sheet.intro_text && (
                        <p className="text-xs text-gray-400 truncate mt-0.5" title={sheet.intro_text}>{sheet.intro_text}</p>
                      )}
                    </div>
                  </div>

                  {/* Access — this column stays. It is the only place the result of a
                      bulk access change is visible, which is exactly what the bulk
                      failure banner above sends the admin to look at. nowrap because
                      the longest label ('Teacher+Exam Only', ~121px) must read on one
                      line inside the 148px this cell leaves it. */}
                  <div style={CELL_PAD}>
                    <span
                      className="text-xs font-medium px-2.5 py-0.5 rounded-full inline-block whitespace-nowrap"
                      style={rolesPillStyle(sheet.allowed_roles)}
                    >
                      {rolesToLabel(sheet.allowed_roles)}
                    </span>
                  </div>

                  {/* Actions — min-w-0 so the file pill can shrink inside the fixed
                      140px track; the kebab is flex-shrink-0 and can never be squeezed
                      out of reach. */}
                  <div className="flex items-center gap-2 min-w-0">
                    {material ? (
                      // No Assign button at all on a file row: /api/admin/library/assign
                      // rejects any sheet whose audience is not 'student' with a 400, so
                      // the button could only ever fail. A read-only link instead — the
                      // index is the ORIGINAL position in attachments, which is what
                      // /api/library-file/[sheetId]/[index] resolves.
                      files.length === 0 ? (
                        <span
                          className="text-xs font-medium px-2.5 py-1 rounded-md flex-shrink-0"
                          style={{ backgroundColor: '#f9fafb', color: '#d1d5db', border: '1px solid #f3f4f6' }}
                        >
                          No file
                        </span>
                      ) : (
                        <>
                          {/* Only the FIRST file is linked here. The attachment count is
                              unbounded (the upload input is `multiple`) and this column
                              is now a fixed track, so one pill per file would overflow it
                              again from two files up. The rest are reachable WITH their
                              names on the Edit modal's Files tab, each with its own View
                              link — which is what the +N tooltip points at. */}
                          <a
                            href={`/api/library-file/${sheet.id}/${files[0].idx}`}
                            target="_blank"
                            rel="noreferrer"
                            title={files[0].att.name}
                            className="text-xs font-medium px-2.5 py-1 rounded-md truncate"
                            style={{ backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8', cursor: 'pointer' }}
                            onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#FFE4C4' }}
                            onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#FFF0E0' }}
                          >
                            {attLabel(files[0].att)}
                          </a>
                          {files.length > 1 && (
                            <span
                              className="text-xs font-medium flex-shrink-0"
                              style={{ color: '#9ca3af' }}
                              title={`${files.length - 1} more ${files.length - 1 === 1 ? 'file' : 'files'} — open this row's Edit menu, Files tab, to see them all`}
                            >
                              +{files.length - 1}
                            </span>
                          )}
                        </>
                      )
                    ) : (
                      <button
                        onClick={empty ? undefined : () => { setAssigningSheet(sheet); setShowAssign(true) }}
                        disabled={empty}
                        title={empty ? 'No content yet' : undefined}
                        className="text-xs font-medium px-2.5 py-1 rounded-md flex-shrink-0"
                        style={
                          empty
                            ? { backgroundColor: '#f9fafb', color: '#d1d5db', border: '1px solid #f3f4f6', cursor: 'not-allowed' }
                            : { backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8', cursor: 'pointer' }
                        }
                        onMouseEnter={e => { if (!empty) e.currentTarget.style.backgroundColor = '#FFE4C4' }}
                        onMouseLeave={e => { if (!empty) e.currentTarget.style.backgroundColor = '#FFF0E0' }}
                      >
                        Assign
                      </button>
                    )}

                    <div className="relative flex-shrink-0" ref={openMenuId === sheet.id ? menuRef : null}>
                      <button
                        onClick={() => setOpenMenuId(prev => (prev === sheet.id ? null : sheet.id))}
                        className="p-1 rounded text-gray-400 hover:text-gray-600"
                        title="More actions"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>

                      {openMenuId === sheet.id && (
                        <div
                          className="absolute right-0 z-20 bg-white rounded-lg shadow-lg"
                          style={{
                            // The card container is overflow-hidden (load-bearing for its
                            // rounded corners), so a menu opening downward on the LAST row is
                            // clipped and Edit/Delete become unreachable. Flip it upward there.
                            // Only above 2 rows: at 2 or fewer the container is too short for
                            // the flipped menu to fit either, and clipping at the top is no
                            // better than clipping at the bottom — so leave those opening down.
                            ...(filtered.length > 2 && idx === filtered.length - 1
                              ? { bottom: 'calc(100% + 4px)' }
                              : { top: 'calc(100% + 4px)' }),
                            border: '1px solid #e5e7eb',
                            minWidth: '150px',
                          }}
                        >
                          {/* Activities only matter for an assignable student sheet,
                              and the assign route blocks staff sheets outright. Edit
                              and Delete stay on every row. */}
                          {!material && (
                            <button
                              onClick={() => { setActivitiesSheet(sheet); setOpenMenuId(null) }}
                              className="block w-full text-left px-4 py-2 text-sm"
                              style={{ color: '#4b5563' }}
                              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
                              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                            >
                              Activities
                            </button>
                          )}
                          <button
                            onClick={() => { setEditingSheet(sheet); setShowForm(true); setOpenMenuId(null) }}
                            className="block w-full text-left px-4 py-2 text-sm"
                            style={{ color: '#4b5563' }}
                            onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
                            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => { setDeleteError(null); setConfirmDeleteId(sheet.id); setOpenMenuId(null) }}
                            className="block w-full text-left px-4 py-2 text-sm"
                            style={{ color: '#FD5602' }}
                            onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#FFF5F2' }}
                            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
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
              Delete this item?
            </h3>
            <p style={{ fontSize: '14px', color: '#6B7280' }}>
              Are you sure you want to delete this item? Its files, activities, assignments, and any student attempt history go with it. This cannot be undone.
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
                  backgroundColor: deletingId === confirmDeleteId ? '#E5E7EB' : '#FD5602',
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
          studentsError={studentsError}
          adminId={adminId}
          onClose={() => { setShowAssign(false); setAssigningSheet(null) }}
        />
      )}

      {/* Activities modal */}
      {activitiesSheet && (
        <ActivitiesModal
          sheetId={activitiesSheet.id}
          sheetTitle={activitiesSheet.title}
          onClose={() => setActivitiesSheet(null)}
        />
      )}

      {/* Tag manager */}
      {showTagManager && (
        <TagManagerModal onClose={() => setShowTagManager(false)} />
      )}
    </div>
  )
}
