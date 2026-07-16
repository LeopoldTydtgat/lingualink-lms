'use client'

import { useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Search,
  Lock,
  LayoutGrid,
  List,
  GraduationCap,
  Users,
  BookOpen,
  Languages,
  ChevronRight,
  Plus,
  MoreVertical,
  Copy,
} from 'lucide-react'
import CreateResourceModal from './CreateResourceModal'

type StudySheet = {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
  is_active: boolean
  created_at: string
  audience: string
  owner_id: string | null
}

type Props = {
  studySheets: StudySheet[]
  isAdmin: boolean
  currentUserId: string
}

type TabKey = 'teaching' | 'student'
type ViewMode = 'grid' | 'list'
type SortKey = 'recent' | 'title'

const LEVELS = ['All', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// UTC parts only: deterministic across the SSR/CSR boundary (no hydration drift)
// and avoids the banned toISOString / toLocale* date APIs.
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function categoryIcon(category: string) {
  return category.toLowerCase() === 'grammar' ? Languages : BookOpen
}

// Reused difficulty-bar logic (unchanged from the previous surface).
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

// Kebab menu with a single "Duplicate to My Library" action. The dropdown is
// fixed-positioned (computed from the button rect) so it escapes the list
// table's overflow-hidden clip. Every handler stops propagation so the kebab
// never triggers the parent card/row navigation.
function DuplicateMenu({ sheetId }: { sheetId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.right - 210 })
    setError(null)
    setOpen(v => !v)
  }

  async function duplicate(e: ReactMouseEvent) {
    e.stopPropagation()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/teacher/library/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_id: sheetId }),
      })
      if (res.status !== 201) {
        let msg = 'Could not duplicate this sheet.'
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        setError(msg)
        setBusy(false)
        return
      }
      setBusy(false)
      setOpen(false)
      router.refresh()
    } catch {
      setError('Could not duplicate this sheet.')
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={toggle}
        aria-label="More actions"
        className="p-1 rounded-md"
        style={{ color: '#9ca3af' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && pos && (
        <>
          <div
            onClick={e => { e.stopPropagation(); setOpen(false) }}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: '210px',
              zIndex: 50,
              backgroundColor: 'white',
              border: '1px solid #E0DFDC',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={duplicate}
              disabled={busy}
              className="flex items-center gap-2 w-full text-left text-sm"
              style={{ padding: '10px 12px', color: '#111827', backgroundColor: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'white')}
            >
              <Copy className="w-4 h-4" style={{ color: '#FF8303' }} />
              {busy ? 'Duplicating...' : 'Duplicate to My Library'}
            </button>
            {error && (
              <p style={{ padding: '8px 12px', fontSize: '12px', color: '#FD5602', borderTop: '1px solid #E0DFDC' }}>
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  caption,
}: {
  icon: typeof GraduationCap
  label: string
  value: number
  caption: string
}) {
  return (
    <div className="flex-1 min-w-[200px] rounded-xl p-5" style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC' }}>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: '32px', height: '32px', backgroundColor: '#FFF3E0' }}
        >
          <Icon className="w-4 h-4" style={{ color: '#FF8303' }} />
        </span>
        <span className="text-sm font-medium" style={{ color: '#4b5563' }}>{label}</span>
      </div>
      <p className="text-3xl font-semibold" style={{ color: '#111827' }}>{value}</p>
      <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{caption}</p>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  caption,
}: {
  active: boolean
  onClick: () => void
  icon?: ReactNode
  label: string
  caption: string
}) {
  return (
    <button
      onClick={onClick}
      className="pb-3 -mb-px text-left"
      style={{ borderBottom: active ? '2px solid #FF8303' : '2px solid transparent' }}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: active ? '#FF8303' : '#4b5563' }}>
        {icon}
        {label}
      </span>
      <span className="block text-xs mt-0.5" style={{ color: '#9ca3af' }}>{caption}</span>
    </button>
  )
}

function Badges({ sheet }: { sheet: StudySheet }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
        style={{ backgroundColor: '#f3f4f6', color: '#4b5563' }}
      >
        {sheet.category}
      </span>
      <span
        className="px-2 py-0.5 rounded-full text-xs font-medium"
        style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
      >
        {sheet.level}
      </span>
      <DifficultyBars count={sheet.difficulty} />
    </div>
  )
}

function SheetCard({ sheet, owned }: { sheet: StudySheet; owned: boolean }) {
  const router = useRouter()
  const Icon = categoryIcon(sheet.category)
  return (
    <div
      onClick={() => router.push(`/study-sheets/${sheet.id}`)}
      className="rounded-xl p-4 transition-shadow"
      style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
    >
      <div className="flex items-start justify-between mb-3">
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: '40px', height: '40px', backgroundColor: '#FFF3E0' }}
        >
          <Icon className="w-5 h-5" style={{ color: '#FF8303' }} />
        </span>
        <div className="flex items-center gap-1">
          {owned && <Lock className="w-4 h-4 mt-1" style={{ color: '#9ca3af' }} aria-label="Private to you" />}
          <DuplicateMenu sheetId={sheet.id} />
        </div>
      </div>
      <h3 className="font-medium text-sm mb-2" style={{ color: '#111827' }}>{sheet.title}</h3>
      <div className="mb-3">
        <Badges sheet={sheet} />
      </div>
      <p className="text-xs" style={{ color: '#9ca3af' }}>{formatDate(sheet.created_at)}</p>
    </div>
  )
}

function SheetTable({
  rows,
  ownedIds,
  emptyMessage,
}: {
  rows: StudySheet[]
  ownedIds: Set<string>
  emptyMessage: string
}) {
  const router = useRouter()
  return (
    <div className="rounded-xl overflow-hidden" style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC' }}>
      <div
        className="grid grid-cols-[1fr_120px_80px_100px_72px] gap-4 px-6 py-3"
        style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #E0DFDC' }}
      >
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#9ca3af' }}>Title</span>
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#9ca3af' }}>Category</span>
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#9ca3af' }}>Level</span>
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#9ca3af' }}>Difficulty</span>
        <span></span>
      </div>

      {rows.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm" style={{ color: '#9ca3af' }}>{emptyMessage}</div>
      ) : (
        rows.map(sheet => (
          <div
            key={sheet.id}
            onClick={() => router.push(`/study-sheets/${sheet.id}`)}
            className="grid grid-cols-[1fr_120px_80px_100px_72px] gap-4 px-6 py-4 transition-colors"
            style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <span className="font-medium text-sm flex items-center gap-1.5" style={{ color: '#111827' }}>
              {ownedIds.has(sheet.id) && (
                <Lock className="w-3.5 h-3.5 shrink-0" style={{ color: '#9ca3af' }} aria-label="Private to you" />
              )}
              {sheet.title}
            </span>
            <span className="text-sm capitalize" style={{ color: '#4b5563' }}>{sheet.category}</span>
            <span className="text-sm">
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
              >
                {sheet.level}
              </span>
            </span>
            <span><DifficultyBars count={sheet.difficulty} /></span>
            <span className="flex items-center justify-end gap-1 self-center">
              <DuplicateMenu sheetId={sheet.id} />
              <ChevronRight className="w-4 h-4" style={{ color: '#9ca3af' }} />
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export default function StudySheetsClient({ studySheets, isAdmin, currentUserId }: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabKey>('teaching')
  const [search, setSearch] = useState('')
  const [selectedLevel, setSelectedLevel] = useState('All')
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [sort, setSort] = useState<SortKey>('recent')
  const [view, setView] = useState<ViewMode>('grid')
  const [showCreate, setShowCreate] = useState(false)

  // Tab membership, independent of search/filters:
  //  - owned (owner_id === me)                        -> Teaching Materials (padlock)
  //  - admin-published staff (owner null, staff)      -> Teaching Materials (no padlock; shared staff material)
  //  - admin-published student (owner null, student)  -> Student Worksheets
  function sheetTab(s: StudySheet): TabKey | null {
    if (s.owner_id === currentUserId) return 'teaching'
    if (s.owner_id === null && s.audience === 'staff') return 'teaching'
    if (s.owner_id === null && s.audience === 'student') return 'student'
    return null
  }

  const teachingCount = studySheets.filter(s => s.owner_id === currentUserId).length
  const worksheetCount = studySheets.filter(s => s.owner_id === null && s.audience === 'student').length
  const ownedIds = new Set(studySheets.filter(s => s.owner_id === currentUserId).map(s => s.id))

  const visible = studySheets
    .filter(s => sheetTab(s) === activeTab)
    .filter(s => {
      const matchesSearch = s.title.toLowerCase().includes(search.toLowerCase())
      const matchesLevel = selectedLevel === 'All' || s.level === selectedLevel
      const matchesCategory = selectedCategory === 'All' || s.category === selectedCategory
      return matchesSearch && matchesLevel && matchesCategory
    })
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : b.created_at.localeCompare(a.created_at)
    )

  const emptyMessage = activeTab === 'teaching' ? 'No private materials yet.' : 'No student worksheets yet.'

  const selectStyle = { backgroundColor: 'white', borderColor: '#E0DFDC', color: '#4b5563' }

  return (
    <div style={{ backgroundColor: '#f9fafb', minHeight: '100%' }}>
      <div className="p-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: '#111827' }}>Study Library</h1>
            <p className="text-sm mt-1" style={{ color: '#4b5563' }}>
              All your resources for planning and teaching
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Every teacher can author private staff material - not admin-gated. */}
            {activeTab === 'teaching' && (
              <Button
                onClick={() => setShowCreate(true)}
                style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Resource
              </Button>
            )}
            {isAdmin && (
              <Button
                onClick={() => router.push('/study-sheets/new')}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
                style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Study Sheet
              </Button>
            )}
          </div>
        </div>

        {/* Stat cards */}
        <div className="flex flex-wrap gap-4 mb-6">
          <StatCard icon={GraduationCap} label="Teaching Resources" value={teachingCount} caption="Private to you" />
          <StatCard icon={Users} label="Student Worksheets" value={worksheetCount} caption="Available to assign" />
        </div>

        {/* Tab bar */}
        <div className="flex gap-6 mb-6" style={{ borderBottom: '1px solid #E0DFDC' }}>
          <TabButton
            active={activeTab === 'teaching'}
            onClick={() => setActiveTab('teaching')}
            icon={<Lock className="w-4 h-4" />}
            label="Teaching Materials"
            caption="Private to you"
          />
          <TabButton
            active={activeTab === 'student'}
            onClick={() => setActiveTab('student')}
            label="Student Worksheets"
            caption="Assign and track student progress"
          />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9ca3af' }} />
            <Input
              placeholder="Search study sheets..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <select
            value={selectedLevel}
            onChange={e => setSelectedLevel(e.target.value)}
            className="px-3 py-2 rounded-md text-sm border"
            style={selectStyle}
          >
            {LEVELS.map(l => (
              <option key={l} value={l}>{l === 'All' ? 'All levels' : l}</option>
            ))}
          </select>

          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="px-3 py-2 rounded-md text-sm border"
            style={selectStyle}
          >
            <option value="All">All categories</option>
            <option value="vocabulary">Vocabulary</option>
            <option value="grammar">Grammar</option>
          </select>

          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="px-3 py-2 rounded-md text-sm border"
            style={selectStyle}
          >
            <option value="recent">Recently added</option>
            <option value="title">Title A-Z</option>
          </select>

          {/* View toggle */}
          <div className="flex gap-1">
            <button
              onClick={() => setView('grid')}
              className="p-2 rounded-md border"
              aria-label="Grid view"
              style={view === 'grid'
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : { backgroundColor: 'white', borderColor: '#E0DFDC', color: '#4b5563' }}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView('list')}
              className="p-2 rounded-md border"
              aria-label="List view"
              style={view === 'list'
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : { backgroundColor: 'white', borderColor: '#E0DFDC', color: '#4b5563' }}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        {view === 'grid' ? (
          visible.length === 0 ? (
            <div
              className="rounded-xl px-6 py-12 text-center text-sm"
              style={{ backgroundColor: '#ffffff', border: '1px solid #E0DFDC', color: '#9ca3af' }}
            >
              {emptyMessage}
            </div>
          ) : (
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {visible.map(sheet => (
                <SheetCard key={sheet.id} sheet={sheet} owned={ownedIds.has(sheet.id)} />
              ))}
            </div>
          )
        ) : (
          <SheetTable rows={visible} ownedIds={ownedIds} emptyMessage={emptyMessage} />
        )}
      </div>

      {showCreate && <CreateResourceModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}
