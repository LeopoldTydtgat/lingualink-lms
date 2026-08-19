import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { getBillability } from '@/lib/billing/billability'
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates'
import {
  recomputeInvoiceAmountsForTeacher,
  recomputeInvoiceAmountsForAllTeachers,
} from '@/lib/billing/recomputeAmounts'
import { getExportTimezone, formatInstantInTz, tzLabel, zonedDayRangeToUtcBounds } from '@/lib/exportTime'
import { buildExportWorkbook, type ExportColumn } from '@/lib/exports/workbook'
import { buildFilterLines } from '@/lib/exports/filterLines'

// ExcelJS is Node-only (Buffer, zlib) — this route must not run on Edge.
export const runtime = 'nodejs'

// ── Helpers ────────────────────────────────────────────────────────────────────────────

// The exact value set the admin billing client's invoice status filter can emit
// (BillingAdminClient.tsx status <select>: pending / uploaded / paid / overdue).
// 'All Statuses' sends no param at all, so absence — not a member of this list —
// is what means "every status". Anything outside the set is rejected rather than
// passed to .eq(), so a typo can never export an empty file that reads as a real,
// settled "no invoices in this status" answer.
const INVOICE_STATUSES: readonly string[] = ['pending', 'uploaded', 'paid', 'overdue']

// Instant (timestamptz) columns render in the resolved export timezone via
// formatInstantInTz. billing_month below is a date-only value (YYYY-MM-01) and
// is NOT an instant, so it keeps its own month formatter.
function formatMonthLabel(dateStr: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long', year: 'numeric',
  }).format(new Date(dateStr + 'T12:00:00Z'))
}

// ── Route ──────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Resolve the settings-driven export timezone once per request. Every instant
  // (timestamptz) column below renders in this zone; its header carries the label.
  const exportTz = await getExportTimezone()
  const exportTzLabel = tzLabel(exportTz)

  const { searchParams } = new URL(req.url)
  // Two types, and only two. The student-progress and pending-reports exports are
  // served by /api/admin/exports/[type] as 'student-progress' and
  // 'pending-reports'; do not re-add them here. The copies that used to live in
  // this file were reachable by no caller, and the student-progress one queried a
  // students embed and a student_id filter that public.reports does not have.
  const type = searchParams.get('type') // 'teacher_invoices' | 'company_billing'
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const teacherId = searchParams.get('teacherId')
  const companyId = searchParams.get('companyId')
  const month = searchParams.get('month') // YYYY-MM-01 for teacher_invoices
  const status = searchParams.get('status') // optional invoice status for teacher_invoices

  // dateFrom/dateTo are bare YYYY-MM-DD calendar days the admin picked in the
  // export timezone, but every column they scope (scheduled_at, created_at) is a
  // timestamptz instant. Passing the bare string makes Postgres read it as UTC
  // midnight, which drops the whole dateTo day and anchors both bounds to the
  // wrong zone. Resolve the window once here, in the same zone the export renders
  // in, into a HALF-OPEN [gte, lt) instant pair — hence .lt, not .lte, below.
  // Each bound is independently optional; only the supplied side is applied.
  let dateGteIso: string | null = null
  let dateLtIso: string | null = null
  if (dateFrom && dateTo) {
    const bounds = zonedDayRangeToUtcBounds(dateFrom, dateTo, exportTz)
    dateGteIso = bounds.gteIso
    dateLtIso = bounds.ltIso
  } else if (dateFrom) {
    dateGteIso = zonedDayRangeToUtcBounds(dateFrom, dateFrom, exportTz).gteIso
  } else if (dateTo) {
    dateLtIso = zonedDayRangeToUtcBounds(dateTo, dateTo, exportTz).ltIso
  }

  let columns: ExportColumn[] = []
  let rows: Record<string, unknown>[] = []
  let title = ''
  let sheetName = ''
  let filename = 'export.xlsx'
  let freezeColumns = 0
  let filterLines: string[] = []

  try {

  // ── 1. Teacher Invoice Summary ────────────────────────────────────────────────────────
  if (type === 'teacher_invoices') {
    // Validate before the recompute below: an unknown status must cost nothing and
    // must not answer 200 with a workbook whose scope the caller did not ask for.
    if (status !== null && !INVOICE_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `Unknown invoice status '${status}'. Expected one of: ${INVOICE_STATUSES.join(', ')}.` },
        { status: 400 }
      )
    }

    // Refresh amount_eur before export so the workbook matches the admin Billing
    // page header. Scope to one teacher when filtered, else recompute everyone.
    if (teacherId) {
      try {
        await recomputeInvoiceAmountsForTeacher(teacherId)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('TIMEZONE_MISSING:')) {
          return NextResponse.json(
            { error: 'TIMEZONE_MISSING', message: 'This teacher has no timezone set. Set it before exporting.' },
            { status: 422 }
          )
        }
        throw err
      }
    } else {
      await recomputeInvoiceAmountsForAllTeachers()
    }

    title = 'Teacher Invoice Summary'
    sheetName = 'Teacher Invoices'
    filename = 'teacher-invoices.xlsx'
    freezeColumns = 2 // Reference + Teacher stay visible when scrolling right

    const uploadedAtHeader = `Uploaded At (${exportTzLabel})`
    const paidAtHeader = `Paid At (${exportTzLabel})`

    columns = [
      { header: 'Reference', key: 'Reference', width: 20 },
      { header: 'Teacher', key: 'Teacher', width: 24 },
      { header: 'Email', key: 'Email', width: 28 },
      { header: 'Month', key: 'Month', width: 16 },
      { header: 'Amount', key: 'Amount', width: 14, format: 'money2' },
      { header: 'Currency', key: 'Currency', width: 10 },
      { header: 'Status', key: 'Status', width: 14 },
      { header: uploadedAtHeader, key: uploadedAtHeader, width: 20 },
      { header: paidAtHeader, key: paidAtHeader, width: 20 },
    ]

    // The embedded profiles join exposes teacher email — read it on the admin
    // client, never the RLS-bound server client (NEW262d). The isAdmin gate
    // above authorises this export; `supabase` stays for that auth check only.
    const adminClient = createAdminClient()
    let query = adminClient
      .from('invoices')
      .select('id, billing_month, amount_eur, status, file_path, uploaded_at, paid_at, reference_number, teacher_id, profiles!invoices_teacher_id_fkey(full_name, email, currency)')
      .order('billing_month', { ascending: false })

    if (teacherId) query = query.eq('teacher_id', teacherId)
    if (month) query = query.eq('billing_month', month)
    // Absent = the client's All Statuses option; validated against INVOICE_STATUSES above.
    if (status) query = query.eq('status', status)

    const { data: invoices, error: invoicesErr } = await query
    if (invoicesErr) throw invoicesErr

    rows = (invoices || []).map(inv => {
      const teacher = Array.isArray(inv.profiles) ? inv.profiles[0] : inv.profiles
      return {
        'Reference': inv.reference_number,
        'Teacher': teacher?.full_name,
        'Email': teacher?.email,
        'Month': formatMonthLabel(inv.billing_month),
        // A real NUMBER, not a formatted string, so Excel sorts and sums it. A
        // null amount_eur still exports as 0 — exactly what the CSV wrote as
        // '0.00' — never a blank cell, which would read as "not yet priced".
        'Amount': inv.amount_eur != null ? Number(inv.amount_eur) : 0,
        'Currency': (teacher as { full_name: string; email: string; currency?: string | null } | null)?.currency || 'EUR',
        'Status': inv.status,
        [uploadedAtHeader]: inv.uploaded_at ? formatInstantInTz(inv.uploaded_at, exportTz) : '',
        [paidAtHeader]: inv.paid_at ? formatInstantInTz(inv.paid_at, exportTz) : '',
      }
    })

    // fromDate/toDate are passed as null DELIBERATELY: this branch never applies
    // dateFrom or dateTo to its query (it scopes by teacher, month and status),
    // so printing a date range in the header block would state a scope this
    // export does not have.
    filterLines = await buildFilterLines(supabase, {
      fromDate: null, toDate: null,
      teacherId, studentId: null, companyId: null,
    })
    if (month) filterLines.push(`Month: ${formatMonthLabel(month)}`)
    if (status) filterLines.push(`Invoice Status: ${status}`)
  }

  // ── 4. Company Billing Report ─────────────────────────────────────────────────────────
  else if (type === 'company_billing') {
    title = 'Company Billing Report'
    sheetName = 'Company Billing'
    filename = 'company-billing.xlsx'
    freezeColumns = 3 // Company + Student + Teacher stay visible when scrolling right

    const dateTimeHeader = `Date & Time (${exportTzLabel})`

    // No totals row on this sheet: Amount is per-lesson in the TEACHER's currency,
    // so one sum would silently add GBP or USD rows into a euro figure the moment
    // a non-EUR teacher appears. A currency-aware total is its own decision.
    columns = [
      { header: 'Company', key: 'Company', width: 24 },
      { header: 'Student', key: 'Student', width: 24 },
      { header: 'Teacher', key: 'Teacher', width: 24 },
      { header: dateTimeHeader, key: dateTimeHeader, width: 20 },
      { header: 'Duration (min)', key: 'Duration (min)', width: 14, format: 'integer' },
      { header: 'Status', key: 'Status', width: 22 },
      { header: 'Billable (24hr)', key: 'Billable (24hr)', width: 16 },
      { header: 'Billable (48hr policy)', key: 'Billable (48hr policy)', width: 22 },
      { header: 'Amount', key: 'Amount', width: 14, format: 'money2' },
      { header: 'Currency', key: 'Currency', width: 10 },
    ]

    // cancellation_policy and hourly_rate have column-level REVOKEs on `authenticated` —
    // must read them via the admin client. The role check above has already gated this branch.
    const adminClient = createAdminClient()

    let companiesQuery = supabase
      .from('companies')
      .select('id, name')
      .order('name')

    if (companyId) companiesQuery = companiesQuery.eq('id', companyId)

    const { data: companies, error: companiesErr } = await companiesQuery
    if (companiesErr) throw companiesErr

    const { data: companyStudents, error: companyStudentsErr } = await adminClient
      .from('students')
      .select('id, full_name, company_id, cancellation_policy')
      .not('company_id', 'is', null)
    if (companyStudentsErr) throw companyStudentsErr

    const studentIds = (companyStudents || []).map(s => s.id)

    let lessonsQuery = adminClient
      .from('lessons')
      .select('id, student_id, teacher_id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by, profiles!lessons_teacher_id_fkey(full_name, hourly_rate, currency)')
      .in('student_id', studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000'])

    if (dateGteIso) lessonsQuery = lessonsQuery.gte('scheduled_at', dateGteIso)
    if (dateLtIso) lessonsQuery = lessonsQuery.lt('scheduled_at', dateLtIso)

    const { data: lessons, error: lessonsErr } = await lessonsQuery
    if (lessonsErr) throw lessonsErr

    // Per-lesson pay rate from lesson_rate_snapshots (adminClient — deny-all RLS).
    // The teacher's live profiles.hourly_rate is used only as the fallback (NEW268 D1).
    const rateMap = await fetchLessonRateMap(adminClient, (lessons ?? []).map(l => l.id))

    for (const company of (companies || [])) {
      const cStudents = (companyStudents || []).filter(s => s.company_id === company.id)

      for (const student of cStudents) {
        const sLessons = (lessons || []).filter(l => l.student_id === student.id)

        for (const lesson of sLessons) {
          const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles

          const bill = getBillability({
            status: lesson.status,
            scheduledAt: lesson.scheduled_at,
            cancelledAt: lesson.cancelled_at,
            cancellationPolicy: student.cancellation_policy as '24hr' | '48hr' | null,
            hourlyRate: resolveLessonRate(rateMap, lesson.id, teacher?.hourly_rate ?? 0),
            durationMinutes: lesson.duration_minutes,
            cancelledBy: lesson.cancelled_by ?? null,
            rescheduledBy: lesson.rescheduled_by ?? null,
          })

          // Skip lessons that are neither billable in any way
          if (!bill.billableToTeacher && !bill.billable48hr) continue

          rows.push({
            'Company': company.name,
            'Student': student.full_name,
            'Teacher': teacher?.full_name || '',
            [dateTimeHeader]: formatInstantInTz(lesson.scheduled_at, exportTz),
            'Duration (min)': lesson.duration_minutes,
            'Status': lesson.status,
            'Billable (24hr)': bill.billableToTeacher ? 'Yes' : 'No',
            'Billable (48hr policy)': bill.billable48hr ? 'Yes' : 'No',
            'Amount': bill.companyAmount,
            'Currency': teacher?.currency || 'EUR',
          })
        }
      }
    }

    filterLines = await buildFilterLines(supabase, {
      fromDate: dateFrom, toDate: dateTo,
      teacherId: null, studentId: null, companyId,
    })
  }

  else {
    return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
  }

  } catch (err: any) {
    console.error(`Export error [${type}]:`, err)
    Sentry.captureException(err)
    return NextResponse.json({ error: err.message ?? 'Export failed' }, { status: 500 })
  }

  const buffer = await buildExportWorkbook({
    title,
    columns,
    rows,
    generatedAtLabel: formatInstantInTz(new Date(), exportTz),
    timezoneLabel: exportTzLabel,
    filterLines,
    sheetName,
    freezeColumns,
  })

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
