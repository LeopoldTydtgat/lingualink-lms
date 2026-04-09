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
    columns: ['Teacher', 'Month', 'Classes Taken', 'Student No-Shows', 'Total Hours', 'Hourly Rate (€)', 'Total Owed (€)', 'Invoice Status'],
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
    if (!q.trim()) { setSuggestions([]); setOpen(false); return }
    setLoading(true)
    try {
      const res = await fetch(fetchUrl(q))
      const data = await res.json()
      // Teachers return data.teachers, students return data.students, companies return data.companies
      const items: Suggestion[] = data.teachers ?? data.students ?? data.companies ?? []
      setSuggestions(items)
      setOpen(true)
    } catch {
      setSuggestions([])
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: '#fff7ed', border: '1px solid #fed7aa',
          borderRadius: '6px', padding: '5px 10px', fontSize: '13px', color: '#9a3412',
        }}>
          <span>{value}</span>
          <button
            onClick={onClear}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9a3412', fontSize: '14px', padding: '0 0 1px 0', lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '200px' }}>
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
        placeholder={placeholder}
        style={{ ...filterInputStyle, width: '100%' }}
      />
      {loading && (
        <div style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '11px', color: '#9ca3af' }}>
          …
        </div>
      )}
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          backgroundColor: '#fff', border: '1px solid #d1d5db', borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', marginTop: '2px',
          maxHeight: '200px', overflowY: 'auto',
        }}>
          {suggestions.map(item => (
            <div
              key={item.id}
              onMouseDown={() => handleSelect(item)}
              style={{
                padding: '8px 12px', fontSize: '13px', color: '#111827',
                cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#fff7ed')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#fff')}
            >
              {item[labelKey]}
            </div>
          ))}
        </div>
      )}
      {open && suggestions.length === 0 && query.trim() && !loading && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          backgroundColor: '#fff', border: '1px solid #d1d5db', borderRadius: '6px',
          padding: '8px 12px', fontSize: '13px', color: '#9ca3af',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', marginTop: '2px',
        }}>
          No results found
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminExportsPage() {
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
  useEffect(() => {
    fetch('/api/admin/companies?minimal=true')
      .then(r => r.json())
      .then(d => setCompanies(d.companies ?? []))
      .catch(() => {})
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
        throw new Error(data.error ?? 'Export failed')
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
    <div style={{ padding: '32px', maxWidth: '1000px' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: 0 }}>Data Exports</h1>
        <p style={{ fontSize: '14px', color: '#6b7280', marginTop: '4px' }}>
          Download CSV reports for analysis in Excel or Google Sheets. Use the filters to narrow by date, teacher, or student.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {EXPORTS.map(exportDef => {
          const f = filters[exportDef.type]
          const isLoading = loading[exportDef.type]
          const err = errors[exportDef.type]

          return (
            <div key={exportDef.type} style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '24px' }}>

              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '14px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', margin: '0 0 4px 0' }}>{exportDef.title}</h2>
                  <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>{exportDef.description}</p>
                </div>
                <button
                  onClick={() => handleDownload(exportDef)}
                  disabled={isLoading}
                  style={{
                    backgroundColor: isLoading ? '#e5e7eb' : '#FF8303',
                    color: isLoading ? '#9ca3af' : '#fff',
                    border: 'none', borderRadius: '8px', padding: '9px 20px',
                    fontSize: '13px', fontWeight: 600,
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  {isLoading ? 'Generating…' : '⬇ Download CSV'}
                </button>
              </div>

              {/* Columns preview */}
              <div style={{ marginBottom: '14px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Columns:</span>
                <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '6px' }}>{exportDef.columns.join(' · ')}</span>
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>

                {exportDef.filters.includes('from') && (
                  <div>
                    <label style={labelStyle}>From</label>
                    <input type="date" value={f.from} onChange={e => setFilter(exportDef.type, { from: e.target.value })} style={filterInputStyle} />
                  </div>
                )}

                {exportDef.filters.includes('to') && (
                  <div>
                    <label style={labelStyle}>To</label>
                    <input type="date" value={f.to} onChange={e => setFilter(exportDef.type, { to: e.target.value })} style={filterInputStyle} />
                  </div>
                )}

                {exportDef.filters.includes('teacher') && (
                  <div>
                    <label style={labelStyle}>Teacher</label>
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
                    <label style={labelStyle}>Student</label>
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
                    <label style={labelStyle}>Company</label>
                    {/* Companies are few enough for a simple dropdown */}
                    {f.companyName ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ backgroundColor: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '6px', padding: '5px 10px', fontSize: '13px', color: '#9a3412', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {f.companyName}
                          <button onClick={() => setFilter(exportDef.type, { companyId: '', companyName: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9a3412', fontSize: '14px', padding: '0 0 1px 0' }}>×</button>
                        </div>
                      </div>
                    ) : (
                      <select
                        value={f.companyId}
                        onChange={e => {
                          const selected = companies.find(c => c.id === e.target.value)
                          setFilter(exportDef.type, { companyId: e.target.value, companyName: selected?.name ?? '' })
                        }}
                        style={{ ...filterInputStyle, width: '180px' }}
                      >
                        <option value="">All companies</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                  </div>
                )}

                {hasFilters(f) && (
                  <button
                    onClick={() => clearFilters(exportDef.type)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '12px', padding: '0 0 1px 0', alignSelf: 'flex-end' }}
                  >
                    Clear all
                  </button>
                )}
              </div>

              {err && (
                <div style={{ marginTop: '12px', backgroundColor: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: '6px', fontSize: '13px' }}>
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

// ─── Shared styles ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 600, color: '#6b7280',
  marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em',
}

const filterInputStyle: React.CSSProperties = {
  border: '1px solid #d1d5db', borderRadius: '6px', padding: '6px 10px',
  fontSize: '13px', color: '#374151', backgroundColor: '#fff', width: '140px',
}
