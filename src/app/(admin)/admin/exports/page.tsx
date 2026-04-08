'use client'

import { useState } from 'react'

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
  teacher: string
  student: string
  company: string
}

const EMPTY_FILTERS: FilterSet = {
  from: '',
  to: '',
  teacher: '',
  student: '',
  company: '',
}

// ─── Export definitions ───────────────────────────────────────────────────────

type ExportDef = {
  type: ExportType
  title: string
  description: string
  filters: (keyof FilterSet)[]
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminExportsPage() {
  // Each export card has its own filter state and loading state
  const [filters, setFilters] = useState<Record<ExportType, FilterSet>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, { ...EMPTY_FILTERS }])) as Record<ExportType, FilterSet>
  )
  const [loading, setLoading] = useState<Record<ExportType, boolean>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, false])) as Record<ExportType, boolean>
  )
  const [errors, setErrors] = useState<Record<ExportType, string | null>>(
    Object.fromEntries(EXPORTS.map(e => [e.type, null])) as Record<ExportType, string | null>
  )

  function updateFilter(type: ExportType, key: keyof FilterSet, value: string) {
    setFilters(prev => ({ ...prev, [type]: { ...prev[type], [key]: value } }))
  }

  async function handleDownload(exportDef: ExportDef) {
    const f = filters[exportDef.type]
    setLoading(prev => ({ ...prev, [exportDef.type]: true }))
    setErrors(prev => ({ ...prev, [exportDef.type]: null }))

    try {
      const params = new URLSearchParams()
      if (f.from) params.set('from', f.from)
      if (f.to) params.set('to', f.to)
      if (f.teacher) params.set('teacher', f.teacher)
      if (f.student) params.set('student', f.student)
      if (f.company) params.set('company', f.company)

      const res = await fetch(`/api/admin/exports/${exportDef.type}?${params.toString()}`)

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Export failed')
      }

      // Trigger browser download
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // Get filename from Content-Disposition header if available
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

      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: 0 }}>
          Data Exports
        </h1>
        <p style={{ fontSize: '14px', color: '#6b7280', marginTop: '4px' }}>
          Download CSV reports for analysis in Excel or Google Sheets.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {EXPORTS.map(exportDef => {
          const f = filters[exportDef.type]
          const isLoading = loading[exportDef.type]
          const err = errors[exportDef.type]

          return (
            <div
              key={exportDef.type}
              style={{
                backgroundColor: '#fff',
                border: '1px solid #e5e7eb',
                borderRadius: '12px',
                padding: '24px',
              }}
            >
              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', margin: '0 0 4px 0' }}>
                    {exportDef.title}
                  </h2>
                  <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>
                    {exportDef.description}
                  </p>
                </div>
                <button
                  onClick={() => handleDownload(exportDef)}
                  disabled={isLoading}
                  style={{
                    backgroundColor: isLoading ? '#e5e7eb' : '#FF8303',
                    color: isLoading ? '#9ca3af' : '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '9px 20px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {isLoading ? 'Generating…' : '⬇ Download CSV'}
                </button>
              </div>

              {/* Columns preview */}
              <div style={{ marginBottom: '14px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Columns:
                </span>
                <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '6px' }}>
                  {exportDef.columns.join(' · ')}
                </span>
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {exportDef.filters.includes('from') && (
                  <div>
                    <label style={labelStyle}>From</label>
                    <input
                      type="date"
                      value={f.from}
                      onChange={e => updateFilter(exportDef.type, 'from', e.target.value)}
                      style={filterInputStyle}
                    />
                  </div>
                )}
                {exportDef.filters.includes('to') && (
                  <div>
                    <label style={labelStyle}>To</label>
                    <input
                      type="date"
                      value={f.to}
                      onChange={e => updateFilter(exportDef.type, 'to', e.target.value)}
                      style={filterInputStyle}
                    />
                  </div>
                )}
                {exportDef.filters.includes('teacher') && (
                  <div>
                    <label style={labelStyle}>Teacher ID (optional)</label>
                    <input
                      type="text"
                      placeholder="Paste teacher UUID"
                      value={f.teacher}
                      onChange={e => updateFilter(exportDef.type, 'teacher', e.target.value)}
                      style={{ ...filterInputStyle, width: '200px' }}
                    />
                  </div>
                )}
                {exportDef.filters.includes('student') && (
                  <div>
                    <label style={labelStyle}>Student ID (optional)</label>
                    <input
                      type="text"
                      placeholder="Paste student UUID"
                      value={f.student}
                      onChange={e => updateFilter(exportDef.type, 'student', e.target.value)}
                      style={{ ...filterInputStyle, width: '200px' }}
                    />
                  </div>
                )}
                {exportDef.filters.includes('company') && (
                  <div>
                    <label style={labelStyle}>Company ID (optional)</label>
                    <input
                      type="text"
                      placeholder="Paste company UUID"
                      value={f.company}
                      onChange={e => updateFilter(exportDef.type, 'company', e.target.value)}
                      style={{ ...filterInputStyle, width: '200px' }}
                    />
                  </div>
                )}

                {/* Clear filters */}
                {(f.from || f.to || f.teacher || f.student || f.company) && (
                  <button
                    onClick={() => setFilters(prev => ({ ...prev, [exportDef.type]: { ...EMPTY_FILTERS } }))}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#9ca3af',
                      fontSize: '12px',
                      padding: '0 0 1px 0',
                      alignSelf: 'flex-end',
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Error */}
              {err && (
                <div style={{
                  marginTop: '12px',
                  backgroundColor: '#fee2e2',
                  color: '#991b1b',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '13px',
                }}>
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
  display: 'block',
  fontSize: '11px',
  fontWeight: 600,
  color: '#6b7280',
  marginBottom: '4px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const filterInputStyle: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  padding: '6px 10px',
  fontSize: '13px',
  color: '#374151',
  backgroundColor: '#fff',
  width: '140px',
}
