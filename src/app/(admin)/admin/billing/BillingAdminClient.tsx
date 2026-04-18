'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CheckCircle } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Invoice {
  id: string
  teacher_id: string
  billing_month: string
  amount_eur: number | null
  status: string
  file_path: string | null
  uploaded_at: string | null
  paid_at: string | null
  reference_number: string | null
}

// hourly_rate is intentionally excluded here — it is fetched on-demand via
// the /api/admin/billing/entities route and never exposed to the browser client
// through a direct Supabase query.
interface TeacherProfile {
  id: string
  full_name: string
  email: string
}

interface Company {
  id: string
  name: string
}

// cancellation_policy is intentionally excluded here — same reason as hourly_rate above.
interface StudentRow {
  id: string
  full_name: string
  email: string
  company_id: string | null
}

interface LessonRow {
  id: string
  teacher_id: string
  student_id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  // hydrated after join
  teacherName: string
  studentName: string
  hourlyRate: number
  cancellationPolicy: string | null
  companyId: string | null
  companyName: string | null
}

type ActiveTab = 'teacher_invoices' | 'student_billing' | 'company_billing'

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${h}:${m}`
}

function lessonAmount(durationMinutes: number, hourlyRate: number): number {
  return Math.round((durationMinutes / 60) * hourlyRate * 100) / 100
}

// Core billability logic — single source of truth, mirrors the export route
function getBillability(
  status: string,
  scheduledAt: string,
  cancelledAt: string | null,
  cancellationPolicy: string | null
): { billableToTeacher: boolean; billable48hr: boolean; label: string; labelColor: string } {
  if (status === 'completed') {
    return { billableToTeacher: true, billable48hr: false, label: 'Billable', labelColor: '#16a34a' }
  }
  if (status === 'student_no_show') {
    return { billableToTeacher: true, billable48hr: false, label: 'Billable (no-show)', labelColor: '#16a34a' }
  }
  if (status === 'teacher_no_show') {
    return { billableToTeacher: false, billable48hr: false, label: 'Not billable', labelColor: '#6b7280' }
  }
  if (status === 'cancelled' && cancelledAt) {
    const classTime = new Date(scheduledAt).getTime()
    const cancelTime = new Date(cancelledAt).getTime()
    const hoursNotice = (classTime - cancelTime) / (1000 * 60 * 60)

    if (hoursNotice < 24) {
      return { billableToTeacher: true, billable48hr: false, label: 'Billable (<24hr)', labelColor: '#16a34a' }
    }
    if (hoursNotice >= 24 && hoursNotice < 48 && cancellationPolicy === '48hr') {
      return { billableToTeacher: false, billable48hr: true, label: '48hr policy', labelColor: '#FF8303' }
    }
    return { billableToTeacher: false, billable48hr: false, label: 'Not billable (>24hr)', labelColor: '#6b7280' }
  }
  return { billableToTeacher: false, billable48hr: false, label: 'Not billable', labelColor: '#6b7280' }
}

function getInvoiceStatusColor(status: string): string {
  switch (status) {
    case 'paid': return '#16a34a'
    case 'uploaded': return '#2563eb'
    case 'pending': return '#FF8303'
    case 'overdue': return '#FD5602'
    default: return '#6b7280'
  }
}

function getLessonStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'Completed'
    case 'student_no_show': return 'Student absent'
    case 'teacher_no_show': return 'Teacher absent'
    case 'cancelled': return 'Cancelled'
    default: return status
  }
}

// Unique months from invoices for the month filter dropdown
function getMonthOptions(invoices: Invoice[]): string[] {
  const seen = new Set<string>()
  for (const inv of invoices) seen.add(inv.billing_month)
  return Array.from(seen).sort((a, b) => b.localeCompare(a))
}

// ── Server-side entity fetcher ─────────────────────────────────────────────────
// Fetches hourly_rate (teachers) and cancellation_policy (students) via an
// API route that uses the service role key. These fields are restricted at the
// database level for the authenticated role and cannot be fetched directly
// from the browser client.

async function fetchBillingEntities(
  teacherIds: string[],
  studentIds: string[]
): Promise<{
  teachers: { id: string; full_name: string; hourly_rate: number | null }[]
  students: { id: string; full_name: string; company_id: string | null; cancellation_policy: string | null }[]
}> {
  const res = await fetch('/api/admin/billing/entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teacherIds, studentIds }),
  })
  if (!res.ok) {
    console.error('fetchBillingEntities failed:', res.status)
    return { teachers: [], students: [] }
  }
  return res.json()
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function BillingAdminClient({ adminId }: { adminId: string }) {
  const supabase = createClient()

  const [activeTab, setActiveTab] = useState<ActiveTab>('teacher_invoices')
  const [toast, setToast] = useState<string | null>(null)

  // ── Shared reference data ──────────────────────────────────────────────────
  const [teachers, setTeachers] = useState<TeacherProfile[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [templateUrl, setTemplateUrl] = useState<string | null>(null)
  const templateInputRef = useRef<HTMLInputElement>(null)
  const [uploadingTemplate, setUploadingTemplate] = useState(false)

  // ── Teacher Invoices tab ───────────────────────────────────────────────────
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [invoiceFilterTeacher, setInvoiceFilterTeacher] = useState('')
  const [invoiceFilterMonth, setInvoiceFilterMonth] = useState('')
  const [invoiceFilterStatus, setInvoiceFilterStatus] = useState('')
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null)
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null)
  const [savingPaid, setSavingPaid] = useState(false)
  const [invoiceLessons, setInvoiceLessons] = useState<Record<string, LessonRow[]>>({})
  const [loadingLessons, setLoadingLessons] = useState<string | null>(null)

  // ── Student Billing tab ────────────────────────────────────────────────────
  const [students, setStudents] = useState<StudentRow[]>([])
  const [sbFilterStudent, setSbFilterStudent] = useState('')
  const [sbFilterDateFrom, setSbFilterDateFrom] = useState('')
  const [sbFilterDateTo, setSbFilterDateTo] = useState('')
  const [sbLessons, setSbLessons] = useState<LessonRow[]>([])
  const [sbLoading, setSbLoading] = useState(false)
  const [sbLoaded, setSbLoaded] = useState(false)

  // ── Company Billing tab ────────────────────────────────────────────────────
  const [cbFilterCompany, setCbFilterCompany] = useState('')
  const [cbFilterDateFrom, setCbFilterDateFrom] = useState('')
  const [cbFilterDateTo, setCbFilterDateTo] = useState('')
  const [cbLessons, setCbLessons] = useState<LessonRow[]>([])
  const [cbLoading, setCbLoading] = useState(false)
  const [cbLoaded, setCbLoaded] = useState(false)

  // ── Load shared reference data on mount ───────────────────────────────────
  // Teachers and companies are fetched without sensitive fields — hourly_rate
  // is fetched on-demand in hydrateLessons via the entities API route.
  const loadBaseData = useCallback(async () => {
    const [{ data: teacherData }, { data: companyData }, { data: invoiceData }, { data: settingsData }] =
      await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name, email')
          .in('role', ['teacher', 'admin'])
          .order('full_name'),
        supabase.from('companies').select('id, name').order('name'),
        supabase.from('invoices').select('*').order('billing_month', { ascending: false }),
        supabase.from('settings').select('value').eq('key', 'invoice_template_path').maybeSingle(),
      ])

    setTeachers(teacherData || [])
    setCompanies(companyData || [])
    setInvoices(invoiceData || [])

    if (settingsData?.value) {
      const { data: urlData } = supabase.storage.from('templates').getPublicUrl(settingsData.value)
      setTemplateUrl(urlData.publicUrl)
    }
  }, [])

  useEffect(() => { loadBaseData() }, [loadBaseData])

  // Load students list for the Student Billing filter dropdown.
  // cancellation_policy is intentionally omitted — it is fetched server-side
  // via the entities API route only when building billing calculations.
  useEffect(() => {
    supabase
      .from('students')
      .select('id, full_name, email, company_id')
      .order('full_name')
      .then(({ data }) => setStudents(data || []))
  }, [])

  // ── Hydrate a raw lessons result with teacher/student/company names ─────────
  // Sensitive fields (hourly_rate, cancellation_policy) are fetched via the
  // /api/admin/billing/entities route — never directly from the browser client.
  const hydrateLessons = useCallback(async (rawLessons: {
    id: string
    teacher_id: string
    student_id: string
    scheduled_at: string
    duration_minutes: number
    status: string
    cancelled_at: string | null
  }[]): Promise<LessonRow[]> => {
    if (!rawLessons.length) return []

    const teacherIds = [...new Set(rawLessons.map(l => l.teacher_id))]
    const studentIds = [...new Set(rawLessons.map(l => l.student_id))]

    // Fetch sensitive fields via server-side API route
    const { teachers: tProfiles, students: sRows } = await fetchBillingEntities(teacherIds, studentIds)

    // Fetch company names directly — companies table has no sensitive columns
    const companyIds = [...new Set(sRows.map(s => s.company_id).filter(Boolean))] as string[]
    let companyMap: Record<string, string> = {}
    if (companyIds.length) {
      const { data: cData } = await supabase.from('companies').select('id, name').in('id', companyIds)
      for (const c of cData || []) companyMap[c.id] = c.name
    }

    const teacherMap: Record<string, { full_name: string; hourly_rate: number }> = {}
    for (const t of tProfiles) teacherMap[t.id] = { full_name: t.full_name, hourly_rate: t.hourly_rate || 0 }

    const studentMap: Record<string, { full_name: string; company_id: string | null; cancellation_policy: string | null }> = {}
    for (const s of sRows) studentMap[s.id] = { full_name: s.full_name, company_id: s.company_id, cancellation_policy: s.cancellation_policy }

    return rawLessons.map(l => {
      const t = teacherMap[l.teacher_id] || { full_name: 'Unknown', hourly_rate: 0 }
      const s = studentMap[l.student_id] || { full_name: 'Unknown', company_id: null, cancellation_policy: null }
      const companyId = s.company_id
      const companyName = companyId ? (companyMap[companyId] || null) : null
      return {
        ...l,
        teacherName: t.full_name,
        studentName: s.full_name,
        hourlyRate: t.hourly_rate,
        cancellationPolicy: s.cancellation_policy,
        companyId,
        companyName,
      }
    })
  }, [])

  // ── Load lessons for an expanded invoice (teacher + month) ────────────────
  const loadInvoiceLessons = useCallback(async (teacherId: string, billingMonth: string) => {
    const key = `${teacherId}_${billingMonth}`
    if (invoiceLessons[key]) return // already loaded

    setLoadingLessons(key)

    const d = new Date(billingMonth + 'T12:00:00Z')
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth()

    const fromDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const toDate = month === 11
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 2).padStart(2, '0')}-01`

    const { data: raw } = await supabase
      .from('lessons')
      .select('id, teacher_id, student_id, scheduled_at, duration_minutes, status, cancelled_at')
      .eq('teacher_id', teacherId)
      .gte('scheduled_at', fromDate)
      .lt('scheduled_at', toDate)
      .order('scheduled_at', { ascending: true })

    const hydrated = await hydrateLessons(raw || [])
    setInvoiceLessons(prev => ({ ...prev, [key]: hydrated }))
    setLoadingLessons(null)
  }, [invoiceLessons, hydrateLessons])

  // ── Mark invoice as paid ───────────────────────────────────────────────────
  const handleMarkPaid = async (invoiceId: string) => {
    setSavingPaid(true)
    await fetch('/api/admin/billing/mark-paid', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId }),
    })
    setSavingPaid(false)
    setMarkingPaidId(null)
    await loadBaseData()
    setToast('Invoice marked as paid!')
    setTimeout(() => setToast(null), 3000)
  }

  // ── View invoice PDF (signed URL) ──────────────────────────────────────────
  const handleViewInvoice = async (filePath: string) => {
    const { data } = await supabase.storage.from('invoices').createSignedUrl(filePath, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // ── Template upload ────────────────────────────────────────────────────────
  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || file.type !== 'application/pdf') return
    if (file.size > 10 * 1024 * 1024) return
    setUploadingTemplate(true)
    const { error } = await supabase.storage
      .from('templates')
      .upload('invoice-template.pdf', file, { upsert: true })
    if (!error) {
      await supabase.from('settings').upsert({
        key: 'invoice_template_path',
        value: 'invoice-template.pdf',
        updated_at: new Date().toISOString(),
      })
      const { data: urlData } = supabase.storage.from('templates').getPublicUrl('invoice-template.pdf')
      setTemplateUrl(urlData.publicUrl)
      setToast('Template uploaded!')
      setTimeout(() => setToast(null), 3000)
    }
    setUploadingTemplate(false)
  }

  // ── Load Student Billing lessons ───────────────────────────────────────────
  const loadStudentBilling = useCallback(async () => {
    setSbLoading(true)
    setSbLoaded(false)

    let query = supabase
      .from('lessons')
      .select('id, teacher_id, student_id, scheduled_at, duration_minutes, status, cancelled_at')
      .in('status', ['completed', 'student_no_show', 'teacher_no_show', 'cancelled'])
      .order('scheduled_at', { ascending: false })

    if (sbFilterStudent) query = query.eq('student_id', sbFilterStudent)
    if (sbFilterDateFrom) query = query.gte('scheduled_at', sbFilterDateFrom)
    if (sbFilterDateTo) query = query.lte('scheduled_at', sbFilterDateTo + 'T23:59:59')

    const { data: raw } = await query
    const hydrated = await hydrateLessons(raw || [])
    setSbLessons(hydrated)
    setSbLoading(false)
    setSbLoaded(true)
  }, [sbFilterStudent, sbFilterDateFrom, sbFilterDateTo, hydrateLessons])

  // ── Load Company Billing lessons ───────────────────────────────────────────
  const loadCompanyBilling = useCallback(async () => {
    setCbLoading(true)
    setCbLoaded(false)

    let studentsQuery = supabase
      .from('students')
      .select('id')
      .not('company_id', 'is', null)

    if (cbFilterCompany) studentsQuery = studentsQuery.eq('company_id', cbFilterCompany)

    const { data: companyStudents } = await studentsQuery
    const studentIds = (companyStudents || []).map(s => s.id)

    if (!studentIds.length) {
      setCbLessons([])
      setCbLoading(false)
      setCbLoaded(true)
      return
    }

    let lessonsQuery = supabase
      .from('lessons')
      .select('id, teacher_id, student_id, scheduled_at, duration_minutes, status, cancelled_at')
      .in('student_id', studentIds)
      .in('status', ['completed', 'student_no_show', 'teacher_no_show', 'cancelled'])
      .order('scheduled_at', { ascending: false })

    if (cbFilterDateFrom) lessonsQuery = lessonsQuery.gte('scheduled_at', cbFilterDateFrom)
    if (cbFilterDateTo) lessonsQuery = lessonsQuery.lte('scheduled_at', cbFilterDateTo + 'T23:59:59')

    const { data: raw } = await lessonsQuery
    const hydrated = await hydrateLessons(raw || [])
    setCbLessons(hydrated)
    setCbLoading(false)
    setCbLoaded(true)
  }, [cbFilterCompany, cbFilterDateFrom, cbFilterDateTo, hydrateLessons])

  // ── CSV export helper ──────────────────────────────────────────────────────
  const downloadCSV = (type: string, extraParams: Record<string, string> = {}) => {
    const params = new URLSearchParams({ type, ...extraParams })
    window.open(`/api/admin/billing/export?${params.toString()}`, '_blank')
  }

  // ── Filtered invoices ──────────────────────────────────────────────────────
  const filteredInvoices = invoices.filter(inv => {
    if (invoiceFilterTeacher && inv.teacher_id !== invoiceFilterTeacher) return false
    if (invoiceFilterMonth && inv.billing_month !== invoiceFilterMonth) return false
    if (invoiceFilterStatus && inv.status !== invoiceFilterStatus) return false
    return true
  })

  const monthOptions = getMonthOptions(invoices)

  // ── Student billing totals ─────────────────────────────────────────────────
  const sbBillableTotal = sbLessons.reduce((sum, l) => {
    const { billableToTeacher } = getBillability(l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy)
    return billableToTeacher ? sum + lessonAmount(l.duration_minutes, l.hourlyRate) : sum
  }, 0)

  // ── Company billing: group by company then student ─────────────────────────
  const cbByCompany: Record<string, { companyName: string; lessons: LessonRow[] }> = {}
  for (const l of cbLessons) {
    const key = l.companyId || 'unknown'
    if (!cbByCompany[key]) cbByCompany[key] = { companyName: l.companyName || 'Unknown Company', lessons: [] }
    cbByCompany[key].lessons.push(l)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const tabs: { key: ActiveTab; label: string }[] = [
    { key: 'teacher_invoices', label: 'Teacher Invoices' },
    { key: 'student_billing', label: 'Student Billing' },
    { key: 'company_billing', label: 'Company Billing' },
  ]

  return (
    <div className="p-6 max-w-6xl">
      <input ref={templateInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleTemplateUpload} />

      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          backgroundColor: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px',
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '14px', color: '#166534', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          <CheckCircle size={16} color="#16a34a" />
          {toast}
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Billing &amp; Invoices</h1>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors"
            style={activeTab === tab.key
              ? { backgroundColor: '#FF8303', color: 'white', borderBottom: '2px solid #FF8303' }
              : { color: '#4b5563' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── TEACHER INVOICES ──────────────────────────────────────────────────── */}
      {activeTab === 'teacher_invoices' && (
        <div className="space-y-5">

          {/* Invoice template management */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Invoice Template</p>
              <p className="text-sm text-gray-500">Upload the Lingualink branded PDF for teachers to download</p>
            </div>
            <div className="flex items-center gap-3">
              {templateUrl && (
                <a href={templateUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline" style={{ color: '#FF8303' }}>
                  View Current
                </a>
              )}
              <button
                onClick={() => templateInputRef.current?.click()}
                disabled={uploadingTemplate}
                className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50"
                style={{ backgroundColor: '#FF8303' }}
              >
                {uploadingTemplate ? 'Uploading…' : templateUrl ? 'Replace Template' : 'Upload Template'}
              </button>
            </div>
          </div>

          {/* Filters + CSV export */}
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={invoiceFilterTeacher}
              onChange={e => setInvoiceFilterTeacher(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
            >
              <option value="">All Teachers</option>
              {teachers.map(t => (
                <option key={t.id} value={t.id}>{t.full_name}</option>
              ))}
            </select>

            <select
              value={invoiceFilterMonth}
              onChange={e => setInvoiceFilterMonth(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
            >
              <option value="">All Months</option>
              {monthOptions.map(m => (
                <option key={m} value={m}>{formatMonth(m)}</option>
              ))}
            </select>

            <select
              value={invoiceFilterStatus}
              onChange={e => setInvoiceFilterStatus(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="uploaded">Uploaded</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </select>

            <button
              onClick={() => downloadCSV('teacher_invoices', {
                ...(invoiceFilterTeacher && { teacherId: invoiceFilterTeacher }),
                ...(invoiceFilterMonth && { month: invoiceFilterMonth }),
              })}
              className="ml-auto flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>

          {/* Invoices table */}
          {filteredInvoices.length === 0 ? (
            <p className="text-sm text-gray-400">No invoices match the current filters.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="divide-y divide-gray-100">
                {filteredInvoices.map(inv => {
                  const teacher = teachers.find(t => t.id === inv.teacher_id)
                  const isExpanded = expandedInvoiceId === inv.id
                  const lessonKey = `${inv.teacher_id}_${inv.billing_month}`
                  const lessonData = invoiceLessons[lessonKey] || []
                  const isLoadingThis = loadingLessons === lessonKey

                  return (
                    <div key={inv.id}>
                      {/* Invoice row */}
                      <div className="px-5 py-4">
                        <div className="flex items-center justify-between">
                          {/* Left: teacher + month + ref */}
                          <div className="flex items-center gap-5 min-w-0">
                            <div className="min-w-0">
                              <p className="font-medium text-gray-900 truncate">{teacher?.full_name || '—'}</p>
                              <p className="text-xs text-gray-400 font-mono">{inv.reference_number || '—'}</p>
                            </div>
                            <span className="text-sm text-gray-600 whitespace-nowrap">{formatMonth(inv.billing_month)}</span>
                          </div>

                          {/* Right: amount, status, actions */}
                          <div className="flex items-center gap-4 flex-shrink-0">
                            <span className="text-sm font-medium text-gray-800">
                              €{inv.amount_eur != null ? Number(inv.amount_eur).toFixed(2) : '0.00'}
                            </span>

                            <span
                              className="text-xs font-medium px-2.5 py-1 rounded-full text-white"
                              style={{ backgroundColor: getInvoiceStatusColor(inv.status) }}
                            >
                              {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                            </span>

                            {inv.file_path && (
                              <button
                                onClick={() => handleViewInvoice(inv.file_path!)}
                                className="text-xs underline flex-shrink-0"
                                style={{ color: '#FF8303' }}
                              >
                                View PDF
                              </button>
                            )}

                            {inv.status !== 'paid' && markingPaidId !== inv.id && (
                              <button
                                onClick={() => setMarkingPaidId(inv.id)}
                                className="px-3 py-1 text-xs rounded-lg text-white flex-shrink-0"
                                style={{ backgroundColor: '#16a34a' }}
                              >
                                Mark Paid
                              </button>
                            )}
                            {inv.paid_at && (
                              <span className="text-xs text-gray-400 whitespace-nowrap">
                                Paid {formatDateTime(inv.paid_at).split(' ')[0]}
                              </span>
                            )}

                            <button
                              onClick={() => {
                                const opening = expandedInvoiceId !== inv.id
                                setExpandedInvoiceId(opening ? inv.id : null)
                                if (opening) loadInvoiceLessons(inv.teacher_id, inv.billing_month)
                              }}
                              className="text-xs underline text-gray-400 flex-shrink-0"
                            >
                              {isExpanded ? 'Hide' : 'Detail'}
                            </button>
                          </div>
                        </div>

                        {/* Confirm paid */}
                        {markingPaidId === inv.id && (
                          <div className="mt-3 flex items-center gap-3 pl-0">
                            <p className="text-sm text-gray-600">
                              Mark <strong>€{inv.amount_eur != null ? Number(inv.amount_eur).toFixed(2) : '0.00'}</strong> as paid for {formatMonth(inv.billing_month)}?
                            </p>
                            <button
                              onClick={() => handleMarkPaid(inv.id)}
                              disabled={savingPaid}
                              className="px-3 py-1.5 text-xs rounded-lg text-white disabled:opacity-50"
                              style={{ backgroundColor: '#16a34a' }}
                            >
                              {savingPaid ? 'Saving…' : 'Confirm'}
                            </button>
                            <button onClick={() => setMarkingPaidId(null)} className="text-xs text-gray-400 underline">
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Expanded: itemised lesson list */}
                      {isExpanded && (
                        <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
                          {isLoadingThis ? (
                            <p className="text-sm text-gray-400">Loading classes…</p>
                          ) : lessonData.length === 0 ? (
                            <p className="text-sm text-gray-400">No classes found for this period.</p>
                          ) : (
                            <>
                              <div className="grid grid-cols-6 gap-3 text-xs font-medium text-gray-400 uppercase mb-2">
                                <span className="col-span-2">Student</span>
                                <span>Date &amp; Time</span>
                                <span>Duration</span>
                                <span>Status</span>
                                <span className="text-right">Amount</span>
                              </div>
                              {lessonData.map(l => {
                                const { billableToTeacher, label, labelColor } = getBillability(
                                  l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy
                                )
                                const amount = billableToTeacher ? lessonAmount(l.duration_minutes, l.hourlyRate) : 0
                                return (
                                  <div key={l.id} className="grid grid-cols-6 gap-3 text-sm py-1.5 border-b border-gray-100 last:border-0">
                                    <span className="col-span-2 text-gray-900 truncate">{l.studentName}</span>
                                    <span className="text-gray-500">{formatDateTime(l.scheduled_at)}</span>
                                    <span className="text-gray-500">{l.duration_minutes} min</span>
                                    <span className="text-xs font-medium" style={{ color: labelColor }}>{label}</span>
                                    <span className="text-right text-gray-700">
                                      {billableToTeacher ? `€${amount.toFixed(2)}` : '—'}
                                    </span>
                                  </div>
                                )
                              })}
                              <div className="flex justify-end mt-3 pt-2 border-t border-gray-200">
                                <span className="text-sm font-semibold text-gray-900">
                                  Total: €{lessonData.reduce((sum, l) => {
                                    const { billableToTeacher } = getBillability(l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy)
                                    return billableToTeacher ? sum + lessonAmount(l.duration_minutes, l.hourlyRate) : sum
                                  }, 0).toFixed(2)}
                                </span>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── STUDENT BILLING ───────────────────────────────────────────────────── */}
      {activeTab === 'student_billing' && (
        <div className="space-y-5">

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Student</label>
              <select
                value={sbFilterStudent}
                onChange={e => setSbFilterStudent(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              >
                <option value="">All Students</option>
                {students.map(s => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">From</label>
              <input
                type="date"
                value={sbFilterDateFrom}
                onChange={e => setSbFilterDateFrom(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">To</label>
              <input
                type="date"
                value={sbFilterDateTo}
                onChange={e => setSbFilterDateTo(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              />
            </div>
            <button
              onClick={loadStudentBilling}
              disabled={sbLoading}
              className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50"
              style={{ backgroundColor: '#FF8303' }}
            >
              {sbLoading ? 'Loading…' : 'Apply'}
            </button>
            <button
              onClick={() => downloadCSV('student_hours', {
                ...(sbFilterStudent && { studentId: sbFilterStudent }),
              })}
              className="ml-auto flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>

          {!sbLoaded && !sbLoading && (
            <p className="text-sm text-gray-400">Select filters and press Apply to load lessons.</p>
          )}

          {sbLoaded && sbLessons.length === 0 && (
            <p className="text-sm text-gray-400">No lessons found for the selected filters.</p>
          )}

          {sbLoaded && sbLessons.length > 0 && (
            <>
              <div className="flex gap-6 bg-white border border-gray-200 rounded-lg px-5 py-3">
                <div>
                  <p className="text-xs text-gray-400">Total classes</p>
                  <p className="text-lg font-semibold text-gray-900">{sbLessons.length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Billable total</p>
                  <p className="text-lg font-semibold text-gray-900">€{sbBillableTotal.toFixed(2)}</p>
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="grid grid-cols-6 gap-3 px-5 py-3 text-xs font-medium text-gray-400 uppercase border-b border-gray-100">
                  <span className="col-span-2">Student / Teacher</span>
                  <span>Date &amp; Time</span>
                  <span>Duration</span>
                  <span>Class Status</span>
                  <span className="text-right">Billable</span>
                </div>
                <div className="divide-y divide-gray-50">
                  {sbLessons.map(l => {
                    const { label, labelColor } = getBillability(
                      l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy
                    )
                    return (
                      <div key={l.id} className="grid grid-cols-6 gap-3 px-5 py-3 text-sm">
                        <div className="col-span-2">
                          <p className="font-medium text-gray-900">{l.studentName}</p>
                          <p className="text-xs text-gray-400">{l.teacherName}</p>
                        </div>
                        <span className="text-gray-600 self-center">{formatDateTime(l.scheduled_at)}</span>
                        <span className="text-gray-600 self-center">{l.duration_minutes} min</span>
                        <span className="text-gray-600 self-center">{getLessonStatusLabel(l.status)}</span>
                        <span className="text-right self-center text-xs font-medium" style={{ color: labelColor }}>
                          {label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── COMPANY BILLING ───────────────────────────────────────────────────── */}
      {activeTab === 'company_billing' && (
        <div className="space-y-5">

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Company</label>
              <select
                value={cbFilterCompany}
                onChange={e => setCbFilterCompany(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              >
                <option value="">All Companies</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">From</label>
              <input
                type="date"
                value={cbFilterDateFrom}
                onChange={e => setCbFilterDateFrom(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">To</label>
              <input
                type="date"
                value={cbFilterDateTo}
                onChange={e => setCbFilterDateTo(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              />
            </div>
            <button
              onClick={loadCompanyBilling}
              disabled={cbLoading}
              className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50"
              style={{ backgroundColor: '#FF8303' }}
            >
              {cbLoading ? 'Loading…' : 'Apply'}
            </button>
            <button
              onClick={() => downloadCSV('company_billing', {
                ...(cbFilterCompany && { companyId: cbFilterCompany }),
                ...(cbFilterDateFrom && { dateFrom: cbFilterDateFrom }),
                ...(cbFilterDateTo && { dateTo: cbFilterDateTo }),
              })}
              className="ml-auto flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>

          {!cbLoaded && !cbLoading && (
            <p className="text-sm text-gray-400">Select filters and press Apply to load company billing data.</p>
          )}

          {cbLoaded && cbLessons.length === 0 && (
            <p className="text-sm text-gray-400">No lessons found for the selected company and date range.</p>
          )}

          {cbLoaded && Object.keys(cbByCompany).length > 0 && (
            <div className="space-y-5">
              {Object.entries(cbByCompany).map(([companyId, { companyName, lessons }]) => {
                const flags48hr = lessons.filter(l => {
                  const { billable48hr } = getBillability(l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy)
                  return billable48hr
                })

                const billableToTeacherLessons = lessons.filter(l => {
                  const { billableToTeacher } = getBillability(l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy)
                  return billableToTeacher
                })

                const totalHours = billableToTeacherLessons.reduce((sum, l) => sum + l.duration_minutes / 60, 0)

                return (
                  <div key={companyId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                      <div>
                        <h3 className="font-semibold text-gray-900">{companyName}</h3>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {lessons.length} classes · {totalHours.toFixed(1)} hours ·{' '}
                          {flags48hr.length > 0 && (
                            <span style={{ color: '#FF8303' }}>{flags48hr.length} billable cancellation{flags48hr.length !== 1 ? 's' : ''} (48hr policy)</span>
                          )}
                          {flags48hr.length === 0 && '0 billable cancellations'}
                        </p>
                      </div>
                    </div>

                    {flags48hr.length > 0 && (
                      <div className="px-5 py-3 border-b border-orange-100" style={{ backgroundColor: '#fff9f5' }}>
                        <p className="text-xs font-medium" style={{ color: '#FF8303' }}>
                          48hr policy cancellations — Lingualink bills the company, teacher is not paid
                        </p>
                        <div className="mt-2 space-y-1">
                          {flags48hr.map(l => (
                            <div key={l.id} className="flex items-center gap-4 text-xs text-gray-600">
                              <span>{l.studentName}</span>
                              <span>{formatDateTime(l.scheduled_at)}</span>
                              <span>{l.duration_minutes} min</span>
                              <span className="font-medium" style={{ color: '#FF8303' }}>48hr cancellation</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="divide-y divide-gray-50">
                      <div className="grid grid-cols-6 gap-3 px-5 py-2 text-xs font-medium text-gray-400 uppercase">
                        <span className="col-span-2">Student / Teacher</span>
                        <span>Date &amp; Time</span>
                        <span>Duration</span>
                        <span>Class Status</span>
                        <span className="text-right">Billing Flag</span>
                      </div>
                      {lessons.map(l => {
                        const { label, labelColor } = getBillability(
                          l.status, l.scheduled_at, l.cancelled_at, l.cancellationPolicy
                        )
                        return (
                          <div key={l.id} className="grid grid-cols-6 gap-3 px-5 py-3 text-sm">
                            <div className="col-span-2">
                              <p className="font-medium text-gray-900">{l.studentName}</p>
                              <p className="text-xs text-gray-400">{l.teacherName}</p>
                            </div>
                            <span className="text-gray-600 self-center">{formatDateTime(l.scheduled_at)}</span>
                            <span className="text-gray-600 self-center">{l.duration_minutes} min</span>
                            <span className="text-gray-600 self-center">{getLessonStatusLabel(l.status)}</span>
                            <span className="text-right self-center text-xs font-medium" style={{ color: labelColor }}>
                              {label}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
