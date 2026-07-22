'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type ExportType =
  | 'all-classes'
  | 'teacher-earnings'
  | 'student-hours'
  | 'company-billing'
  | 'student-progress'
  | 'pending-reports'

type FilterSet = {
  from: string
  to: string
  teacherId: string
  teacherName: string
  studentId: string
  studentName: string
  companyId: string
  companyName: string
}

const EMPTY_FILTERS: FilterSet = {
  from: '', to: '',
  teacherId: '', teacherName: '',
  studentId: '', studentName: '',
  companyId: '', companyName: '',
}

type Suggestion = { id: string; full_name?: string; name?: string }

// ─── Export definitions ───────────────────────────────────────────────────────

type FilterKey = 'from' | 'to' | 'teacher' | 'student' | 'company'

type ExportDef = {
  type: ExportType
  title: string
  description: string
  filters: FilterKey[]
  columns: string[]
}

const EXPORTS: ExportDef[] = [
  {
    type: 'all-classes',
    title: 'All Classes Report',
    description: 'Every class across all teachers — with status, report status, and billability flag.',
    filters: ['from', 'to', 'teacher', 'student', 'company'],
    columns: ['Date', 'Time', 'Teacher', 'Student', 'Company', 'Duration', 'Status', 'Report Status', 'Billable to Teacher', 'Cancellation Reason'],
  },
  {
    type: 'teacher-earnings',
    title: 'Teacher Earnings Summary',
    description: 'Monthly earnings per teacher — classes taken, no-shows, hours, rate, and total owed.',
    filters: ['from', 'to', 'teacher'],
    columns: ['Teacher', 'Month', 'Classes Taken', 'Student No-Shows', 'Total Hours', 'Hourly Rate', 'Total Owed', 'Currency', 'Invoice Status'],
  },
  {
    type: 'student-hours',
    title: 'Student Hours Usage',
    description: 'Training package hours — total purchased, used, remaining, and end date per student.',
    filters: ['student', 'company'],
    columns: ['Student', 'Company', 'Package', 'Total Hours', 'Hours Used', 'Hours Remaining', 'Start Date', 'End Date', 'Status'],
  },
  {
    type: 'company-billing',
    title: 'Company Billing Report',
    description: 'Billable classes per B2B company — includes 48hr cancellation policy flags.',
    filters: ['from', 'to', 'company'],
    columns: ['Company', 'Student', 'Date', 'Time', 'Duration', 'Status', 'Billable (standard)', 'Billable cancellation (48hr policy)'],
  },
  {
    type: 'student-progress',
    title: 'Student Progress Report',
    description: 'Level data from every completed class report — grammar, expression, comprehension, and more.',
    filters: ['from', 'to', 'teacher', 'student'],
    columns: ['Student', 'Class Date', 'Teacher', 'Grammar', 'Expression', 'Comprehension', 'Vocabulary', 'Accent', 'Overall Spoken', 'Overall Written'],
  },
  {
    type: 'pending-reports',
    title: 'Pending Reports Log',
    description: 'All pending and flagged reports — with teacher, student, class time, and hours since class.',
    filters: ['from', 'to', 'teacher'],
    columns: ['Teacher', 'Student', 'Class Date', 'Hours Since Class', 'Report Status', 'Deadline', 'Flagged At'],
  },
]

// ─── Shared styles ────────────────────────────────────────────────────────────

// Filter labels — small uppercase caption above each control.
const filterLabelClass = "block text-[11px] font-semibold text-gray-500 mb-1 uppercase tracking-[0.04em]"

// Filter inputs/selects — reference input styling; width is set per usage site.
const filterInputClass = "border border-[#E0DFDC] rounded-lg px-2.5 py-1.5 text-[13px] text-gray-700 bg-white transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"

// Selected-entity pill (teacher / student / company).
const pillClass = "flex items-center gap-1.5 rounded-lg border border-[#E0DFDC] bg-[#FFF0E0] px-2.5 py-[5px] text-[13px] text-[#FF8303]"
const pillClearClass = "bg-transparent border-none cursor-pointer text-[#FF8303] text-sm leading-none pb-px"

// ─── Autocomplete input component ────────────────────────────────────────────

function AutocompleteInput({
  placeholder,
  value,
  onSelect,
  onClear,
  fetchUrl,
  labelKey,
}: {
  placeholder: string
  value: string        // display name currently selected
  onSelect: (id: string, name: string) => void
  onClear: () => void
  fetchUrl: (search: string) => string
  labelKey: 'full_name' | 'name'
}) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setSuggestions([]); setOpen(false); setSearchError(false); return }
    setLoading(true)
    setSearchError(false)
    try {
      const res = await fetch(fetchUrl(q))
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      // Teachers return data.teachers, students return data.students, companies return data.companies
      const items: Suggestion[] = data.teachers ?? data.students ?? data.companies ?? []
      setSuggestions(items)
      setOpen(true)
    } catch {
      setSuggestions([])
      setSearchError(true)
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }, [fetchUrl])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(q), 250)
  }

  function handleSelect(item: Suggestion) {
    const name = item[labelKey] ?? ''
    onSelect(item.id, name)
    setQuery('')
    setSuggestions([])
    setOpen(false)
  }

  // If a value is already selected, show it as a pill
  if (value) {
    return (
      <div className="flex items-center gap-1.5">
        <div className={pillClass}>
          <span>{value}</span>
          <button onClick={onClear} className={pillClearClass}>
            ×
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative w-[200px]">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
        placeholder={placeholder}
        className={`${filterInputClass} w-full`}
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-400">
          …
        </div>
      )}
      {open && suggestions.length > 0 && (
        <div className="thin-scroll absolute top-full left-0 right-0 z-50 mt-0.5 max-h-[200px] overflow-y-auto rounded-lg border border-[#E0DFDC] bg-white shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
          {suggestions.map(item => (
            <div
              key={item.id}
              onMouseDown={() => handleSelect(item)}
              className="cursor-pointer border-b border-[#E0DFDC] px-3 py-2 text-[13px] text-gray-900 hover:bg-gray-50"
            >
              {item[labelKey]}
            </div>
          ))}
        </div>
      )}
      {open && searchError && (
        <div className="absolute top-full left-0 right-0 z-50 mt-0.5 rounded-lg border border-[#E0DFDC] border-l-[3px] border-l-[#FD5602] bg-[#FFEEE6] px-3 py-2 text-[13px] text-[#FD5602] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
          Couldn&apos;t search. Try again.
        </div>
      )}
      {open && !searchError && suggestions.length === 0 && query.trim() && !loading && (
        <div className="absolute top-full left-0 right-0 z-50 mt-0.5 rounded-lg border border-[#E0DFDC] bg-white px-3 py-2 text-[13px] text-gray-400 shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
          No results found
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ExportsPageClient() {
  const [filters, setFilters] = useState<Record<ExportType, FilterSet>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, { ...EMPTY_FILTERS }])) as Record<ExportType, FilterSet>
  )
  const [loading, setLoading] = useState<Record<ExportType, boolean>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, false])) as Record<ExportType, boolean>
  )
  const [errors, setErrors] = useState<Record<ExportType, string | null>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, null])) as Record<ExportType, string | null>
  )

  // Companies list loaded once for the company filter (small list, no need for autocomplete)
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [companiesError, setCompaniesError] = useState(false)
  useEffect(() => {
    fetch('/api/admin/companies?minimal=true')
      .then(r => {
        if (!r.ok) throw new Error('Failed to load companies')
        return r.json()
      })
      .then(d => setCompanies(d.companies ?? []))
      .catch(() => setCompaniesError(true))
  }, [])

  function setFilter(type: ExportType, updates: Partial<FilterSet>) {
    setFilters(prev => ({ ...prev, [type]: { ...prev[type], ...updates } }))
  }

  function clearFilters(type: ExportType) {
    setFilters(prev => ({ ...prev, [type]: { ...EMPTY_FILTERS } }))
  }

  function hasFilters(f: FilterSet) {
    return f.from || f.to || f.teacherId || f.studentId || f.companyId
  }

  async function handleDownload(exportDef: ExportDef) {
    const f = filters[exportDef.type]
    setLoading(prev => ({ ...prev, [exportDef.type]: true }))
    setErrors(prev => ({ ...prev, [exportDef.type]: null }))

    try {
      const params = new URLSearchParams()
      if (f.from) params.set('from', f.from)
      if (f.to) params.set('to', f.to)
      if (f.teacherId) params.set('teacher', f.teacherId)
      if (f.studentId) params.set('student', f.studentId)
      if (f.companyId) params.set('company', f.companyId)

      const res = await fetch(`/api/admin/exports/${exportDef.type}?${params.toString()}`)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message ?? data.error ?? 'Export failed')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const disposition = res.headers.get('Content-Disposition')
      const match = disposition?.match(/filename="(.+)"/)
      a.download = match?.[1] ?? `${exportDef.type}-export.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setErrors(prev => ({ ...prev, [exportDef.type]: err.message }))
    } finally {
      setLoading(prev => ({ ...prev, [exportDef.type]: false }))
    }
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── Page header ── */}
      <div
        className="w-full flex items-center justify-between pb-4 border-b"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Data Exports</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Download CSV reports for analysis in Excel or Google Sheets. Use the filters to narrow by date, teacher, or student.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {EXPORTS.map(exportDef => {
          const f = filters[exportDef.type]
          const isLoading = loading[exportDef.type]
          const err = errors[exportDef.type]

          return (
            <div key={exportDef.type} className="card-elevated p-6">

              {/* Card header */}
              <div className="flex flex-wrap items-start justify-between gap-4 mb-3.5">
                <div className="flex-1 min-w-[200px]">
                  <h2 className="text-base font-bold text-gray-900 mb-1">{exportDef.title}</h2>
                  <p className="text-[13px] text-gray-500">{exportDef.description}</p>
                </div>
                <button
                  onClick={() => handleDownload(exportDef)}
                  disabled={isLoading}
                  className="btn-primary-hover shrink-0 whitespace-nowrap rounded-lg px-5 py-2 text-[13px] font-semibold text-white"
                  style={{
                    // Disabled/loading state greys the button out — state-dependent, stays inline.
                    backgroundColor: isLoading ? '#e5e7eb' : '#FF8303',
                    color: isLoading ? '#9ca3af' : '#fff',
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isLoading ? 'Generating…' : '⬇ Download CSV'}
                </button>
              </div>

              {/* Columns preview */}
              <div className="mb-3.5">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.05em]">Columns:</span>
                <span className="text-xs text-gray-500 ml-1.5">{exportDef.columns.join(' · ')}</span>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap items-end gap-3">

                {exportDef.filters.includes('from') && (
                  <div>
                    <label className={filterLabelClass}>From</label>
                    <input
                      type="date"
                      value={f.from}
                      onChange={e => setFilter(exportDef.type, { from: e.target.value })}
                      className={`${filterInputClass} w-[140px]`}
                    />
                  </div>
                )}

                {exportDef.filters.includes('to') && (
                  <div>
                    <label className={filterLabelClass}>To</label>
                    <input
                      type="date"
                      value={f.to}
                      onChange={e => setFilter(exportDef.type, { to: e.target.value })}
                      className={`${filterInputClass} w-[140px]`}
                    />
                  </div>
                )}

                {exportDef.filters.includes('teacher') && (
                  <div>
                    <label className={filterLabelClass}>Teacher</label>
                    <AutocompleteInput
                      placeholder="Search by name…"
                      value={f.teacherName}
                      onSelect={(id, name) => setFilter(exportDef.type, { teacherId: id, teacherName: name })}
                      onClear={() => setFilter(exportDef.type, { teacherId: '', teacherName: '' })}
                      fetchUrl={q => `/api/admin/teachers?minimal=true&search=${encodeURIComponent(q)}`}
                      labelKey="full_name"
                    />
                  </div>
                )}

                {exportDef.filters.includes('student') && (
                  <div>
                    <label className={filterLabelClass}>Student</label>
                    <AutocompleteInput
                      placeholder="Search by name…"
                      value={f.studentName}
                      onSelect={(id, name) => setFilter(exportDef.type, { studentId: id, studentName: name })}
                      onClear={() => setFilter(exportDef.type, { studentId: '', studentName: '' })}
                      fetchUrl={q => `/api/admin/students?minimal=true&search=${encodeURIComponent(q)}`}
                      labelKey="full_name"
                    />
                  </div>
                )}

                {exportDef.filters.includes('company') && (
                  <div>
                    <label className={filterLabelClass}>Company</label>
                    {/* Companies are few enough for a simple dropdown */}
                    {f.companyName ? (
                      <div className="flex items-center gap-1.5">
                        <div className={pillClass}>
                          {f.companyName}
                          <button
                            onClick={() => setFilter(exportDef.type, { companyId: '', companyName: '' })}
                            className={pillClearClass}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <select
                          value={f.companyId}
                          onChange={e => {
                            const selected = companies.find(c => c.id === e.target.value)
                            setFilter(exportDef.type, { companyId: e.target.value, companyName: selected?.name ?? '' })
                          }}
                          className={`${filterInputClass} w-[180px]`}
                        >
                          <option value="">All companies</option>
                          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {companiesError && (
                          <p className="mt-1 rounded-lg bg-[#FFEEE6] px-2 py-1 text-[11px] text-[#FD5602]">
                            Couldn&apos;t load companies. Refresh to try again.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {hasFilters(f) && (
                  <button
                    onClick={() => clearFilters(exportDef.type)}
                    className="self-end bg-transparent border-none cursor-pointer pb-px text-xs text-gray-400"
                  >
                    Clear all
                  </button>
                )}
              </div>

              {err && (
                <div className="mt-3 rounded-lg bg-[#FFEEE6] px-3 py-2 text-[13px] text-[#FD5602]">
                  {err}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
