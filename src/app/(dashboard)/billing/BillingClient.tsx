'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getBillability } from '@/lib/billing/billability'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { Receipt, CheckCircle2, Info, ChevronDown } from 'lucide-react'

interface Profile {
  id: string
  full_name: string
  role: string
}

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

interface Lesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  students: { full_name: string } | { full_name: string }[] | null
  // Per-lesson pay rate resolved server-side (snapshot ?? live profiles.hourly_rate).
  rate: number
}

interface BillingInfoDisplay {
  preferred_payment_type: string | null
  paypal_email: string | null
  iban: string | null
  bic: string | null
  tax_number: string | null
  street_address: string | null
  area_code: string | null
  city: string | null
  hourly_rate: number | null
  currency: string | null
  timezone: string | null
}

// "2026-04-01" → "April 2026"
function formatMonth(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00Z')
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

// Manual date/time build to avoid hydration mismatch
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const mins = String(date.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${mins}`
}

function getStatusLabel(lesson: { status: string; cancelled_by?: string | null; rescheduled_by?: string | null }): string {
  const cancelLabel = getCancellationLabel(lesson, 'teacher')
  if (cancelLabel !== null) return cancelLabel
  switch (lesson.status) {
    case 'completed': return 'Completed'
    case 'student_no_show': return 'Student absent'
    case 'teacher_no_show': return 'Teacher absent'
    default: return lesson.status
  }
}

function getLessonStatusStyle(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'completed': return { bg: '#DCFCE7', fg: '#15803D' }
    case 'student_no_show': return { bg: '#FFF0E0', fg: '#C2410C' }
    case 'teacher_no_show': return { bg: '#FFEEE6', fg: '#FD5602' }
    case 'cancelled':
    case 'cancelled_by_student':
    case 'cancelled_by_teacher': return { bg: '#f3f4f6', fg: '#6b7280' }
    default: return { bg: '#f3f4f6', fg: '#6b7280' }
  }
}

function getInvoiceStatusStyle(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'paid': return { bg: '#DCFCE7', fg: '#15803D' }
    case 'pending': return { bg: '#FFF8E8', fg: '#B45309' }
    case 'overdue': return { bg: '#FFEEE6', fg: '#FD5602' }
    default: return { bg: '#f3f4f6', fg: '#6b7280' }
  }
}

function currencySymbol(code: string | null | undefined): string {
  if (code === 'USD') return '$'
  if (code === 'GBP') return '£'
  return '€'
}

// Supabase joins return object or array depending on relationship — flatten safely
function getStudentName(lesson: Lesson): string {
  if (!lesson.students) return 'Unknown'
  if (Array.isArray(lesson.students)) return lesson.students[0]?.full_name || 'Unknown'
  return (lesson.students as { full_name: string }).full_name || 'Unknown'
}

export default function BillingClient({
  profile,
  billingInfo: initialBillingInfo,
  initialInvoices,
  initialLessonsByMonth,
  initialTemplateUrl,
  currentMonthDate,
}: {
  profile: Profile
  billingInfo: BillingInfoDisplay | null
  initialInvoices: Invoice[]
  initialLessonsByMonth: Record<string, Lesson[]>
  initialTemplateUrl: string | null
  currentMonthDate: string
}) {
  const supabase = createClient()
  const router = useRouter()
  const isAdmin = profile.role === 'admin'

  const now = new Date()
  const isUploadWindow = now.getDate() >= 1 && now.getDate() <= 10

  const [activeView, setActiveView] = useState<'billing' | 'billingInfo' | 'admin'>('billing')
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null)

  // Server-fetched on every load. page.tsx ensures the current invoice row,
  // recomputes amount_eur, then fetches invoices + lessons + templateUrl.
  // Mutations (upload, mark-paid) call router.refresh() to rerun the server
  // component and get fresh props.
  const allInvoices = initialInvoices
  const lessonsByMonth = initialLessonsByMonth
  const templateUrl = initialTemplateUrl

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [targetInvoice, setTargetInvoice] = useState<{ id: string; billing_month: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccessId, setUploadSuccessId] = useState<string | null>(null)

  // FIX: initialised from server-side prop instead of fetched client-side
  const [billingInfo] = useState<BillingInfoDisplay | null>(initialBillingInfo)
  const sym = currencySymbol(billingInfo?.currency)

  const [allTeacherInvoices, setAllTeacherInvoices] = useState<
    { teacher: { id: string; full_name: string }; invoices: Invoice[] }[]
  >([])
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null)
  const [savingPaid, setSavingPaid] = useState(false)
  const [markPaidError, setMarkPaidError] = useState<string | null>(null)

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return

    // FIX: removed profiles fetch — use server-side data where possible
    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('role', ['teacher', 'admin'])
      .order('full_name')

    if (!teachers) return

    const { data: invoices } = await supabase
      .from('invoices')
      .select('*')
      .order('billing_month', { ascending: false })

    setAllTeacherInvoices(
      teachers.map(teacher => ({
        teacher,
        invoices: (invoices || []).filter(inv => inv.teacher_id === teacher.id),
      }))
    )
  }, [isAdmin])

  useEffect(() => { if (activeView === 'admin') loadAdminData() }, [activeView, loadAdminData])

  const triggerUpload = (invoiceId: string, billingMonth: string) => {
    setTargetInvoice({ id: invoiceId, billing_month: billingMonth })
    setUploadError(null)
    fileInputRef.current?.click()
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !targetInvoice) return

    // Client-side pre-checks for UX only — the route re-validates
    // MIME (via magic bytes), size, ownership, and the upload window.
    if (file.type !== 'application/pdf') { setUploadError('Only PDF files are accepted.'); return }
    if (file.size > 5 * 1024 * 1024) { setUploadError('File must be under 5 MB.'); return }

    setUploading(true)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('invoiceId', targetInvoice.id)

    const res = await fetch('/api/teacher/invoice/upload', { method: 'POST', body: formData })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setUploadError(body.error || 'Upload failed. Please try again.')
      setUploading(false)
      return
    }

    setUploadSuccessId(targetInvoice.id)
    setTimeout(() => setUploadSuccessId(null), 4000)

    setUploading(false)
    router.refresh()
  }

  const handleViewInvoice = async (invoiceId: string) => {
    // Signing happens server-side. The browser client can't read invoices
    // outside RLS, and we want admin viewing to work without exposing private
    // file paths to the page.
    setViewingInvoiceId(invoiceId)
    try {
      const res = await fetch('/api/teacher/invoice/sign-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      })
      if (!res.ok) return
      const { signedUrl } = await res.json()
      if (signedUrl) window.open(signedUrl, '_blank')
    } finally {
      setViewingInvoiceId(null)
    }
  }

  const handleMarkPaid = async (invoiceId: string) => {
    setSavingPaid(true)
    setMarkPaidError(null)
    try {
      const res = await fetch('/api/admin/billing/mark-paid', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      })
      if (!res.ok) {
        // 422 returns { error, message }; other failures carry only { error }
        const body = await res.json().catch(() => ({}))
        setMarkPaidError(body.message || body.error || 'Failed to mark invoice as paid.')
        setSavingPaid(false)
        return
      }
      setMarkingPaidId(null)
      setSavingPaid(false)
      await loadAdminData()
    } catch {
      setMarkPaidError('Something went wrong. Please try again.')
      setSavingPaid(false)
    }
  }

  return (
    <div className="space-y-6">

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleUpload}
      />

      {/* Header + view switcher */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <h1 className="text-2xl font-bold text-gray-900">Billing &amp; Invoices</h1>
        <div className="flex gap-2">
          {(['billing', 'billingInfo'] as const).map(view => (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              className={`px-4 py-2 text-sm rounded-lg border transition-colors${activeView === view ? ' btn-primary-hover' : ''}`}
              onMouseEnter={activeView === view ? e => (e.currentTarget.style.backgroundColor = '#e67300') : undefined}
              onMouseLeave={activeView === view ? e => (e.currentTarget.style.backgroundColor = '#FF8303') : undefined}
              style={activeView === view
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : {}}
            >
              {view === 'billing' ? 'My Invoices' : 'My Billing Info'}
            </button>
          ))}
          {isAdmin && (
            <button
              onClick={() => setActiveView('admin')}
              className={`px-4 py-2 text-sm rounded-lg border transition-colors${activeView === 'admin' ? ' btn-primary-hover' : ''}`}
              onMouseEnter={activeView === 'admin' ? e => (e.currentTarget.style.backgroundColor = '#e67300') : undefined}
              onMouseLeave={activeView === 'admin' ? e => (e.currentTarget.style.backgroundColor = '#FF8303') : undefined}
              style={activeView === 'admin'
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : {}}
            >
              Admin View
            </button>
          )}
        </div>
      </div>

      {/* ── MY INVOICES ─────────────────────────────────────────────────────── */}
      {activeView === 'billing' && (
        <div className="space-y-6">
          {(() => {
            const currentInv = allInvoices.find(i => i.billing_month === currentMonthDate)
            const currentAmt = currentInv?.amount_eur != null ? Number(currentInv.amount_eur) : 0
            const lastPaid = allInvoices.find(i => i.status === 'paid')
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                  <div className="flex items-center gap-2 mb-2">
                    <Receipt size={14} color="#FF8303" style={{ flexShrink: 0 }} />
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Current Month</p>
                  </div>
                  <p style={{ fontSize: '22px', fontWeight: 700, color: '#111827' }}>
                    {sym}{currentAmt.toFixed(2)}
                  </p>
                  <p style={{ fontSize: '12px', color: '#9ca3af' }}>{formatMonth(currentMonthDate)}</p>
                </div>
                <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 size={14} color="#16a34a" style={{ flexShrink: 0 }} />
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Last Paid</p>
                  </div>
                  <p style={{ fontSize: '22px', fontWeight: 700, color: '#111827' }}>
                    {lastPaid ? `${sym}${Number(lastPaid.amount_eur ?? 0).toFixed(2)}` : '—'}
                  </p>
                  <p style={{ fontSize: '12px', color: '#9ca3af' }}>
                    {lastPaid ? formatMonth(lastPaid.billing_month) : 'No paid invoices yet'}
                  </p>
                </div>
              </div>
            )
          })()}

          {isUploadWindow ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800">
              Invoice upload window is open — upload by the 10th. Payment within 15 days of receipt.
            </div>
          ) : (
            <p className="text-sm text-gray-500 flex items-center gap-2">
              <Info size={14} className="text-gray-400" />
              Invoices are uploaded between the 1st and 10th of each month. Late uploads are processed the following month.
            </p>
          )}

          <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Invoice Template</p>
              <p className="text-sm text-gray-500">Download the Lingualink branded template to complete your invoice</p>
            </div>
            {templateUrl ? (
              <a href={templateUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm rounded-lg text-white btn-primary-hover" onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')} onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')} style={{ backgroundColor: '#FF8303' }}>
                Download Template
              </a>
            ) : (
              <span className="text-sm text-gray-400">No template uploaded yet</span>
            )}
          </div>

          <div className="space-y-3">
          {allInvoices.map(invoice => {
            const isCurrentMonth = invoice.billing_month === currentMonthDate
            const isExpanded = expandedInvoice === invoice.id
            const lessons = lessonsByMonth[invoice.billing_month] || []
            const isThisUploading = uploading && targetInvoice?.id === invoice.id
            const invStyle = getInvoiceStatusStyle(invoice.status)

            return (
              <div
                key={invoice.id}
                className="rounded-xl overflow-hidden shadow-sm"
                style={isCurrentMonth
                  ? { border: '1px solid #f3f4f6', borderLeft: '3px solid #FF8303', backgroundColor: '#fff9f5' }
                  : { border: '1px solid #f3f4f6', backgroundColor: 'white' }}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-gray-400 font-mono mb-0.5">
                        {invoice.reference_number || '—'}
                      </p>
                      <p className="text-lg font-semibold text-gray-900">
                        {formatMonth(invoice.billing_month)}
                        {isCurrentMonth && (
                          <span className="ml-2 text-xs font-normal text-gray-400">Current</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-base font-medium text-gray-700">
                        {invoice.amount_eur != null
                          ? `${sym}${Number(invoice.amount_eur).toFixed(2)}`
                          : `${sym}0.00`}
                      </span>
                      <span
                        className="text-xs font-medium px-2.5 py-1 rounded-full"
                        style={{ backgroundColor: invStyle.bg, color: invStyle.fg }}
                      >
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </span>
                      <button
                        onClick={() => setExpandedInvoice(expandedInvoice === invoice.id ? null : invoice.id)}
                        className="text-sm"
                        style={{ color: '#FF8303', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {isExpanded ? 'Hide Detail' : 'See Detail'}
                        <ChevronDown size={14} style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
                      </button>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                    {lessons.length === 0 ? (
                      <p className="text-sm text-gray-400">No billable classes for this month.</p>
                    ) : (() => {
                      const rows = lessons.map(lesson => ({
                        lesson,
                        bill: getBillability({
                          status: lesson.status,
                          scheduledAt: lesson.scheduled_at,
                          cancelledAt: lesson.cancelled_at,
                          cancellationPolicy: null,
                          // Per-lesson rate from lesson_rate_snapshots, resolved server-side
                          // in billing/page.tsx (snapshot ?? live profiles.hourly_rate).
                          hourlyRate: lesson.rate,
                          durationMinutes: lesson.duration_minutes,
                        }),
                      }))
                      const total = rows.reduce((s, { bill }) => bill.billableToTeacher ? s + bill.amount : s, 0)
                      return (
                        <div>
                          <div
                            className="text-xs text-gray-400 font-medium pb-1 mb-1 border-b border-gray-200"
                            style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.2fr 0.6fr 1fr 0.6fr', alignItems: 'center', gap: '12px' }}
                          >
                            <span>Student</span>
                            <span>Date &amp; Time</span>
                            <span>Duration</span>
                            <span>Status</span>
                            <span style={{ textAlign: 'right' }}>Amount</span>
                          </div>
                          {rows.map(({ lesson, bill }) => {
                            const lessonStyle = getLessonStatusStyle(lesson.status)
                            return (
                              <div
                                key={lesson.id}
                                className="text-sm py-1"
                                style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.2fr 0.6fr 1fr 0.6fr', alignItems: 'center', gap: '12px' }}
                              >
                                <span className="font-medium text-gray-900 truncate">
                                  {getStudentName(lesson)}
                                </span>
                                <span className="text-gray-500">{formatDateTime(lesson.scheduled_at)}</span>
                                <span className="text-gray-500">{lesson.duration_minutes} min</span>
                                <span>
                                  <span
                                    className="text-xs px-2 py-0.5 rounded-full"
                                    style={{ backgroundColor: lessonStyle.bg, color: lessonStyle.fg }}
                                  >
                                    {getStatusLabel(lesson)}
                                  </span>
                                </span>
                                <span className="text-sm text-gray-900" style={{ textAlign: 'right' }}>
                                  {bill.billableToTeacher ? `${sym}${bill.amount.toFixed(2)}` : `${sym}0.00`}
                                </span>
                              </div>
                            )
                          })}
                          <div className="flex justify-end pt-2 mt-1 border-t border-gray-200">
                            <span className="text-sm font-semibold text-gray-900">
                              Total: {sym}{total.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}

                <div className="border-t border-gray-100 px-4 py-3 flex items-center gap-4">
                  {invoice.file_path ? (
                    <>
                      <button
                        onClick={() => handleViewInvoice(invoice.id)}
                        disabled={viewingInvoiceId === invoice.id}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {viewingInvoiceId === invoice.id ? 'Opening...' : 'View Invoice'}
                      </button>
                      <div className="flex items-center gap-1.5 text-sm text-gray-500">
                        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                        Invoice uploaded {invoice.uploaded_at ? formatDateTime(invoice.uploaded_at) : ''}
                      </div>
                      {isUploadWindow && !isCurrentMonth && (
                        <button
                          onClick={() => triggerUpload(invoice.id, invoice.billing_month)}
                          disabled={isThisUploading}
                          className="text-sm underline text-gray-400 ml-auto disabled:opacity-50"
                        >
                          {isThisUploading ? 'Uploading…' : 'Replace'}
                        </button>
                      )}
                    </>
                  ) : (isUploadWindow && !isCurrentMonth) ? (
                    <>
                      <button
                        onClick={() => triggerUpload(invoice.id, invoice.billing_month)}
                        disabled={isThisUploading}
                        className="px-3 py-1.5 text-sm rounded-lg border disabled:opacity-50"
                        style={{ borderColor: '#FF8303', color: '#FF8303' }}
                      >
                        {isThisUploading ? 'Uploading…' : 'Upload invoice'}
                      </button>
                      <div className="flex items-center gap-1.5 text-sm text-gray-400">
                        <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                        Please upload your invoice
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-gray-400">
                      {isCurrentMonth
                        ? 'Upload window opens on the 1st of next month.'
                        : 'No invoice uploaded for this month.'}
                    </p>
                  )}
                </div>

                {uploadError && targetInvoice?.id === invoice.id && (
                  <div className="px-4 pb-3"><p className="text-sm text-red-600">{uploadError}</p></div>
                )}
                {uploadSuccessId === invoice.id && (
                  <div className="px-4 pb-3"><p className="text-sm text-green-600">Invoice uploaded successfully.</p></div>
                )}
              </div>
            )
          })}
          </div>
        </div>
      )}

      {/* ── MY BILLING INFO ──────────────────────────────────────────────────── */}
      {activeView === 'billingInfo' && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-lg">
          <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              To update this information please contact us at <strong>teachers@lingualinkonline.com</strong>
            </p>
          </div>
          {!billingInfo || (!billingInfo.iban && !billingInfo.paypal_email && !billingInfo.tax_number) ? (
            <p className="text-sm text-gray-400">No billing information on file yet. Please contact admin to add your details.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <span className="text-gray-500 w-44 flex-shrink-0">Preferred Payment Type:</span>
                {billingInfo.preferred_payment_type === 'paypal' ? (
                  <span className="text-gray-900 font-medium">PayPal</span>
                ) : billingInfo.preferred_payment_type === 'bank' ? (
                  <span className="text-gray-900 font-medium">Bank Transfer</span>
                ) : (
                  <span className="text-gray-400">Not set</span>
                )}
              </div>
              {billingInfo.preferred_payment_type === 'paypal' && billingInfo.paypal_email && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">PayPal Email:</span>
                  <span className="text-gray-900">{billingInfo.paypal_email}</span>
                </div>
              )}
              {billingInfo.iban && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">IBAN:</span>
                  <span className="text-gray-900 font-mono">{billingInfo.iban}</span>
                </div>
              )}
              {billingInfo.bic && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">SWIFT / BIC:</span>
                  <span className="text-gray-900 font-mono">{billingInfo.bic}</span>
                </div>
              )}
              {billingInfo.tax_number && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">Tax Number:</span>
                  <span className="text-gray-900">{billingInfo.tax_number}</span>
                </div>
              )}
              {billingInfo.street_address && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">Street Address:</span>
                  <span className="text-gray-900">{billingInfo.street_address}</span>
                </div>
              )}
              {(billingInfo.area_code || billingInfo.city) && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-44 flex-shrink-0">Location:</span>
                  <span className="text-gray-900">
                    {[billingInfo.area_code, billingInfo.city].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ADMIN VIEW ───────────────────────────────────────────────────────── */}
      {activeView === 'admin' && isAdmin && (
        <div className="space-y-6">

          {allTeacherInvoices.length === 0 ? (
            <p className="text-sm text-gray-400">No teachers found.</p>
          ) : (
            allTeacherInvoices.map(({ teacher, invoices }) => (
              <div key={teacher.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">{teacher.full_name}</h3>
                </div>
                {invoices.length === 0 ? (
                  <p className="p-4 text-sm text-gray-400">No invoices yet.</p>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {invoices.map(invoice => (
                      <div key={invoice.id} className="px-4 py-3">
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-5">
                            <span className="font-mono text-xs text-gray-400 w-36 truncate">
                              {invoice.reference_number || '—'}
                            </span>
                            <span className="font-medium text-gray-900">{formatMonth(invoice.billing_month)}</span>
                            <span className="text-gray-700">
                              {invoice.amount_eur != null ? `${sym}${Number(invoice.amount_eur).toFixed(2)}` : `${sym}0.00`}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span
                              className="text-xs px-2 py-0.5 rounded-full"
                              style={{ backgroundColor: getInvoiceStatusStyle(invoice.status).bg, color: getInvoiceStatusStyle(invoice.status).fg }}
                            >
                              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                            </span>
                            {invoice.file_path && (
                              <button
                                onClick={() => handleViewInvoice(invoice.id)}
                                disabled={viewingInvoiceId === invoice.id}
                                className="text-xs underline disabled:opacity-50"
                                style={{ color: '#FF8303' }}
                              >
                                {viewingInvoiceId === invoice.id ? 'Opening...' : 'View PDF'}
                              </button>
                            )}
                            {invoice.status !== 'paid' && markingPaidId !== invoice.id && (
                              <button
                                onClick={() => setMarkingPaidId(invoice.id)}
                                className="px-3 py-1 text-xs rounded-lg text-white"
                                style={{ backgroundColor: '#16a34a' }}
                              >
                                Mark Paid
                              </button>
                            )}
                            {invoice.paid_at && (
                              <span className="text-xs text-gray-400">
                                Paid {new Date(invoice.paid_at).toLocaleDateString('en-GB')}
                              </span>
                            )}
                          </div>
                        </div>

                        {markingPaidId === invoice.id && (
                          <div className="mt-3 flex items-center gap-3">
                            <p className="text-sm text-gray-600">
                              Mark <strong>{sym}{invoice.amount_eur != null ? Number(invoice.amount_eur).toFixed(2) : '0.00'}</strong> as paid for {formatMonth(invoice.billing_month)}?
                            </p>
                            <button
                              onClick={() => handleMarkPaid(invoice.id)}
                              disabled={savingPaid}
                              className="px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-50"
                              style={{ backgroundColor: '#16a34a' }}
                            >
                              {savingPaid ? 'Saving…' : 'Confirm'}
                            </button>
                            <button onClick={() => { setMarkingPaidId(null); setMarkPaidError(null) }} className="text-sm text-gray-400 underline">
                              Cancel
                            </button>
                          </div>
                        )}
                        {markingPaidId === invoice.id && markPaidError && (
                          <p className="mt-2 text-sm" style={{ color: '#dc2626' }}>{markPaidError}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

    </div>
  )
}
