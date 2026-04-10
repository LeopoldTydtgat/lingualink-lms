'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

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
  students: { full_name: string } | { full_name: string }[] | null
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

function getStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'Completed'
    case 'student_no_show': return 'Student absent'
    case 'teacher_no_show': return 'Teacher absent'
    case 'cancelled': return 'Cancelled'
    default: return status
  }
}

function getLessonStatusColor(status: string): string {
  switch (status) {
    case 'completed': return '#16a34a'
    case 'student_no_show': return '#FF8303'
    case 'teacher_no_show': return '#FD5602'
    default: return '#6b7280'
  }
}

function getInvoiceStatusColor(status: string): string {
  switch (status) {
    case 'paid': return '#16a34a'
    case 'pending': return '#FF8303'
    case 'overdue': return '#FD5602'
    default: return '#6b7280'
  }
}

// Supabase joins return object or array depending on relationship — flatten safely
function getStudentName(lesson: Lesson): string {
  if (!lesson.students) return 'Unknown'
  if (Array.isArray(lesson.students)) return lesson.students[0]?.full_name || 'Unknown'
  return (lesson.students as { full_name: string }).full_name || 'Unknown'
}

// Calculate the billable amount for a set of lessons at a given hourly rate
// Formula: (duration_minutes / 60) × hourly_rate, summed across all lessons
function calculateAmount(lessons: Lesson[], hourlyRate: number): number {
  const total = lessons.reduce((sum, lesson) => {
    return sum + (lesson.duration_minutes / 60) * hourlyRate
  }, 0)
  return Math.round(total * 100) / 100 // round to 2 decimal places
}

export default function BillingClient({ profile }: { profile: Profile }) {
  const supabase = createClient()
  const isAdmin = profile.role === 'admin'

  const now = new Date()
  const currentMonthDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const isUploadWindow = now.getDate() >= 1 && now.getDate() <= 10

  const [activeView, setActiveView] = useState<'billing' | 'billingInfo' | 'admin'>('billing')
  const [allInvoices, setAllInvoices] = useState<Invoice[]>([])
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null)
  // All lessons pre-loaded and grouped by billing month key (YYYY-MM-01)
  const [lessonsByMonth, setLessonsByMonth] = useState<Record<string, Lesson[]>>({})

  // Single hidden file input shared across all upload buttons
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [targetInvoice, setTargetInvoice] = useState<{ id: string; billing_month: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccessId, setUploadSuccessId] = useState<string | null>(null)

  const [billingInfo, setBillingInfo] = useState<BillingInfoDisplay | null>(null)
  const [templateUrl, setTemplateUrl] = useState<string | null>(null)

  // Admin
  const [allTeacherInvoices, setAllTeacherInvoices] = useState<
    { teacher: { id: string; full_name: string; email: string }; invoices: Invoice[] }[]
  >([])
  const [uploadingTemplate, setUploadingTemplate] = useState(false)
  const templateInputRef = useRef<HTMLInputElement>(null)
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null)
  const [savingPaid, setSavingPaid] = useState(false)

  // ─── Auto-create invoice record for current month ─────────────────────
  const ensureCurrentInvoice = useCallback(async () => {
    const { data: existing } = await supabase
      .from('invoices')
      .select('id')
      .eq('teacher_id', profile.id)
      .eq('billing_month', currentMonthDate)
      .maybeSingle()

    if (!existing) {
      const refNumber = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
      await supabase.from('invoices').insert({
        teacher_id: profile.id,
        billing_month: currentMonthDate,
        status: 'pending',
        reference_number: refNumber,
      })
    }
  }, [profile.id, currentMonthDate])

  // ─── Main data load ───────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    await ensureCurrentInvoice()

    // Fetch invoices and profile (including hourly_rate) in parallel
    const [{ data: invoicesData }, { data: profileData }] = await Promise.all([
      supabase
        .from('invoices')
        .select('*')
        .eq('teacher_id', profile.id)
        .order('billing_month', { ascending: false }),
      supabase
        .from('profiles')
        .select('preferred_payment_type, paypal_email, iban, bic, tax_number, street_address, area_code, city, hourly_rate')
        .eq('id', profile.id)
        .single(),
    ])

    if (profileData) setBillingInfo(profileData)

    const hourlyRate = profileData?.hourly_rate ?? 0

    // Load ALL billable lessons in a single query — grouped client-side by month.
    // This avoids multiple per-month queries and makes "See Detail" instant.
    const { data: allLessons } = await supabase
      .from('lessons')
      .select('id, scheduled_at, duration_minutes, status, students(full_name)')
      .eq('teacher_id', profile.id)
      .in('status', ['completed', 'student_no_show'])
      .order('scheduled_at', { ascending: true })

    // Group lessons by billing month key (first day of that month, YYYY-MM-01)
    const grouped: Record<string, Lesson[]> = {}
    for (const lesson of (allLessons as Lesson[]) || []) {
      const d = new Date(lesson.scheduled_at)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(lesson)
    }
    setLessonsByMonth(grouped)

    // Auto-calculate and save amount_eur for every invoice.
    // This runs on every page load so the current month's total stays live
    // and past months stay accurate in case a report was ever corrected.
    if (hourlyRate > 0 && invoicesData) {
      const updates = invoicesData
        .map(invoice => {
          const lessons = grouped[invoice.billing_month] || []
          const calculated = calculateAmount(lessons, hourlyRate)
          // Only write if the stored value differs (avoids unnecessary DB writes)
          if (invoice.amount_eur === calculated) return null
          return supabase
            .from('invoices')
            .update({ amount_eur: calculated })
            .eq('id', invoice.id)
        })
        .filter(Boolean)

      if (updates.length > 0) {
        await Promise.all(updates)
        // Reload invoices so the UI shows the freshly calculated amounts
        const { data: refreshed } = await supabase
          .from('invoices')
          .select('*')
          .eq('teacher_id', profile.id)
          .order('billing_month', { ascending: false })
        setAllInvoices(refreshed || [])
      } else {
        setAllInvoices(invoicesData || [])
      }
    } else {
      setAllInvoices(invoicesData || [])
    }

    // Invoice template download URL
    const { data: settingsData } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'invoice_template_path')
      .maybeSingle()

    if (settingsData?.value) {
      const { data: urlData } = supabase.storage.from('templates').getPublicUrl(settingsData.value)
      setTemplateUrl(urlData.publicUrl)
    }
  }, [profile.id, currentMonthDate])

  // ─── Load admin data ──────────────────────────────────────────────────
  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return

    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name, email')
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

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { if (activeView === 'admin') loadAdminData() }, [activeView, loadAdminData])

  // ─── Upload: set target invoice then open file picker ─────────────────
  const triggerUpload = (invoiceId: string, billingMonth: string) => {
    setTargetInvoice({ id: invoiceId, billing_month: billingMonth })
    setUploadError(null)
    fileInputRef.current?.click()
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !targetInvoice) return

    if (file.type !== 'application/pdf') { setUploadError('Only PDF files are accepted.'); return }
    if (file.size > 5 * 1024 * 1024) { setUploadError('File must be under 5 MB.'); return }

    setUploading(true)

    const [year, month] = targetInvoice.billing_month.split('-')
    const fileName = `${profile.id}/${year}-${month}.pdf`

    const { error: storageError } = await supabase.storage
      .from('invoices')
      .upload(fileName, file, { upsert: true })

    if (storageError) {
      setUploadError('Upload failed. Please try again.')
      setUploading(false)
      return
    }

    const { error: dbError } = await supabase
      .from('invoices')
      .update({ file_path: fileName, uploaded_at: new Date().toISOString() })
      .eq('id', targetInvoice.id)

    if (dbError) {
      setUploadError('File uploaded but record update failed. Please contact admin.')
    } else {
      setUploadSuccessId(targetInvoice.id)
      setTimeout(() => setUploadSuccessId(null), 4000)
    }

    setUploading(false)
    await loadData()
  }

  const handleViewInvoice = async (filePath: string) => {
    const { data } = await supabase.storage.from('invoices').createSignedUrl(filePath, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // ─── Admin: template upload ───────────────────────────────────────────
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
    }
    setUploadingTemplate(false)
  }

  // ─── Admin: mark invoice as paid ─────────────────────────────────────
  // Amount is already calculated automatically — Shannon just confirms payment
  const handleMarkPaid = async (invoiceId: string) => {
    setSavingPaid(true)
    await supabase
      .from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', invoiceId)
    setMarkingPaidId(null)
    setSavingPaid(false)
    await loadAdminData()
  }

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl">

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleUpload}
      />

      {/* Header + view switcher */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Billing &amp; Invoices</h1>
        <div className="flex gap-2">
          {(['billing', 'billingInfo'] as const).map(view => (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              className="px-4 py-2 text-sm rounded-lg border transition-colors"
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
              className="px-4 py-2 text-sm rounded-lg border transition-colors"
              style={activeView === 'admin'
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : {}}
            >
              Admin View
            </button>
          )}
        </div>
      </div>

      {/* ── MY INVOICES ─────────────────────────────────────────────────── */}
      {activeView === 'billing' && (
        <div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 mb-4">
            <strong>Invoice upload window: 1st–10th of each month.</strong> Late uploads are processed the following month. Payment is made within 15 days of receipt.
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between mb-6">
            <div>
              <p className="font-medium text-gray-900">Invoice Template</p>
              <p className="text-sm text-gray-500">Download the Lingualink branded template to complete your invoice</p>
            </div>
            {templateUrl ? (
              <a href={templateUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm rounded-lg text-white" style={{ backgroundColor: '#FF8303' }}>
                Download Template
              </a>
            ) : (
              <span className="text-sm text-gray-400">No template uploaded yet</span>
            )}
          </div>

          {/* Invoice cards */}
          {allInvoices.map(invoice => {
            const isCurrentMonth = invoice.billing_month === currentMonthDate
            const isExpanded = expandedInvoice === invoice.id
            const lessons = lessonsByMonth[invoice.billing_month] || []
            const isThisUploading = uploading && targetInvoice?.id === invoice.id

            return (
              <div
                key={invoice.id}
                className="rounded-lg overflow-hidden mb-3 border"
                style={isCurrentMonth
                  ? { borderColor: '#FF8303', backgroundColor: '#fff9f5' }
                  : { borderColor: '#e5e7eb', backgroundColor: 'white' }}
              >
                {/* Top: ref, month, amount, status, See Detail */}
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
                      {/* Amount — auto-calculated from lessons × hourly rate */}
                      <span className="text-base font-medium text-gray-700">
                        {invoice.amount_eur != null
                          ? `€${Number(invoice.amount_eur).toFixed(2)}`
                          : '€0.00'}
                      </span>
                      <span
                        className="text-xs font-medium px-2.5 py-1 rounded-full text-white"
                        style={{ backgroundColor: getInvoiceStatusColor(invoice.status) }}
                      >
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </span>
                      <button
                        onClick={() => setExpandedInvoice(expandedInvoice === invoice.id ? null : invoice.id)}
                        className="text-sm underline text-gray-500"
                      >
                        {isExpanded ? 'Hide Detail' : 'See Detail'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded: itemised lesson list */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                    {lessons.length === 0 ? (
                      <p className="text-sm text-gray-400">No billable classes for this month.</p>
                    ) : (
                      <div className="space-y-1">
                        {lessons.map(lesson => (
                          <div key={lesson.id} className="flex items-center justify-between text-sm py-1">
                            <div className="flex items-center gap-6">
                              <span className="font-medium text-gray-900 w-40 truncate">
                                {getStudentName(lesson)}
                              </span>
                              <span className="text-gray-500">{formatDateTime(lesson.scheduled_at)}</span>
                              <span className="text-gray-500">{lesson.duration_minutes} min</span>
                            </div>
                            <span
                              className="text-xs px-2 py-0.5 rounded-full text-white"
                              style={{ backgroundColor: getLessonStatusColor(lesson.status) }}
                            >
                              {getStatusLabel(lesson.status)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Bottom: upload / view actions */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center gap-4">
                  {invoice.file_path ? (
                    <>
                      <button
                        onClick={() => handleViewInvoice(invoice.file_path!)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                      >
                        View Invoice
                      </button>
                      <div className="flex items-center gap-1.5 text-sm text-gray-500">
                        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                        Invoice uploaded {invoice.uploaded_at ? formatDateTime(invoice.uploaded_at) : ''}
                      </div>
                      {isUploadWindow && (
                        <button
                          onClick={() => triggerUpload(invoice.id, invoice.billing_month)}
                          disabled={isThisUploading}
                          className="text-sm underline text-gray-400 ml-auto disabled:opacity-50"
                        >
                          {isThisUploading ? 'Uploading…' : 'Replace'}
                        </button>
                      )}
                    </>
                  ) : isUploadWindow ? (
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
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
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
      )}

      {/* ── MY BILLING INFO (read-only) ──────────────────────────────────── */}
      {activeView === 'billingInfo' && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-lg">
          <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              To update this information please contact us at <strong>admin@lingualinkonline.com</strong>
            </p>
          </div>
          {!billingInfo || (!billingInfo.iban && !billingInfo.paypal_email && !billingInfo.tax_number) ? (
            <p className="text-sm text-gray-400">No billing information on file yet. Please contact admin to add your details.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <span className="text-gray-500 w-44 flex-shrink-0">Preferred Payment Type:</span>
                <span className="text-gray-900 font-medium">
                  {billingInfo.preferred_payment_type === 'paypal' ? 'PayPal' : 'Bank Transfer'}
                </span>
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
                  <span className="text-gray-500 w-44 flex-shrink-0">BIC:</span>
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

      {/* ── ADMIN VIEW ───────────────────────────────────────────────────── */}
      {activeView === 'admin' && isAdmin && (
        <div className="space-y-6">

          <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Invoice Template</p>
              <p className="text-sm text-gray-500">Upload the Lingualink branded PDF for teachers to download and complete</p>
            </div>
            <div className="flex items-center gap-3">
              {templateUrl && (
                <a href={templateUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline" style={{ color: '#FF8303' }}>
                  View Current
                </a>
              )}
              <input ref={templateInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleTemplateUpload} />
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

          {allTeacherInvoices.length === 0 ? (
            <p className="text-sm text-gray-400">No teachers found.</p>
          ) : (
            allTeacherInvoices.map(({ teacher, invoices }) => (
              <div key={teacher.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">{teacher.full_name}</h3>
                  <span className="text-sm text-gray-400">{teacher.email}</span>
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
                            {/* Amount is auto-calculated — no manual entry needed */}
                            <span className="text-gray-700">
                              {invoice.amount_eur != null ? `€${Number(invoice.amount_eur).toFixed(2)}` : '€0.00'}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span
                              className="text-xs px-2 py-0.5 rounded-full text-white"
                              style={{ backgroundColor: getInvoiceStatusColor(invoice.status) }}
                            >
                              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                            </span>
                            {invoice.file_path && (
                              <button
                                onClick={() => handleViewInvoice(invoice.file_path!)}
                                className="text-xs underline"
                                style={{ color: '#FF8303' }}
                              >
                                View PDF
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

                        {/* Confirm paid — no amount input needed, it's already calculated */}
                        {markingPaidId === invoice.id && (
                          <div className="mt-3 flex items-center gap-3">
                            <p className="text-sm text-gray-600">
                              Mark <strong>€{invoice.amount_eur != null ? Number(invoice.amount_eur).toFixed(2) : '0.00'}</strong> as paid for {formatMonth(invoice.billing_month)}?
                            </p>
                            <button
                              onClick={() => handleMarkPaid(invoice.id)}
                              disabled={savingPaid}
                              className="px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-50"
                              style={{ backgroundColor: '#16a34a' }}
                            >
                              {savingPaid ? 'Saving…' : 'Confirm'}
                            </button>
                            <button onClick={() => setMarkingPaidId(null)} className="text-sm text-gray-400 underline">
                              Cancel
                            </button>
                          </div>
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
