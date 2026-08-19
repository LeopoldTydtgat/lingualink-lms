import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { getBillability } from '@/lib/billing/billability'
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates'
import { getDayKeyInTz, getMonthKeyInTz } from '@/lib/billing/monthRange'
import { getExportTimezone, formatInstantInTz, formatDateInTz, tzLabel } from '@/lib/exportTime'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { buildExportWorkbook, type ExportColumn } from '@/lib/exports/workbook'
import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

// ExcelJS is Node-only (Buffer, zlib) — this route must not run on Edge.
export const runtime = 'nodejs'

// Date-only helper — used for `date`-typed columns (training start/end) that are
// NOT instants and must stay exactly as stored. Instant (timestamptz) columns are
// rendered in the resolved export timezone via formatInstantInTz / formatDateInTz.
function formatDate(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

// Human-readable description of the filters actually applied, written into the
// workbook header block so a saved file is self-describing. IDs resolve to names
// through the cookie client (the route is already admin-gated). A missing row or
// a failed read degrades to the raw id — this must never throw and must never
// block an export.
async function buildFilterLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  f: {
    fromDate: string | null
    toDate: string | null
    teacherId: string | null
    studentId: string | null
    companyId: string | null
  }
): Promise<string[]> {
  const lines: string[] = []

  if (f.fromDate || f.toDate) {
    lines.push(`Date range: ${f.fromDate || 'start'} to ${f.toDate || 'today'}`)
  }

  if (f.teacherId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', f.teacherId).maybeSingle()
      name = data?.full_name ?? null
    } catch {
      name = null
    }
    lines.push(`Teacher: ${name ?? f.teacherId}`)
  }

  if (f.studentId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('students').select('full_name').eq('id', f.studentId).maybeSingle()
      name = data?.full_name ?? null
    } catch {
      name = null
    }
    lines.push(`Student: ${name ?? f.studentId}`)
  }

  if (f.companyId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('companies').select('name').eq('id', f.companyId).maybeSingle()
      name = data?.name ?? null
    } catch {
      name = null
    }
    lines.push(`Company: ${name ?? f.companyId}`)
  }

  return lines
}

// Teacher billability comes from the canonical getBillability() in @/lib/billing/billability — do not reintroduce a local copy.

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const supabase = await createClient()
  const { type } = await params

  const adminUser = await requireAdmin()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Resolve the settings-driven export timezone once per request. Every instant
  // (timestamptz) column below renders in this zone and its header carries the
  // zone's short label. Date-only columns are unaffected.
  const exportTz = await getExportTimezone()
  const exportTzLabel = tzLabel(exportTz)

  const { searchParams } = new URL(request.url)
  const fromDate = searchParams.get('from')   // YYYY-MM-DD
  const toDate = searchParams.get('to')       // YYYY-MM-DD
  const teacherId = searchParams.get('teacher')
  const studentId = searchParams.get('student')
  const companyId = searchParams.get('company')

  // Convert date strings to UTC range boundaries
  const fromTs = fromDate ? `${fromDate}T00:00:00.000Z` : null
  const toTs   = toDate   ? `${toDate}T23:59:59.999Z`   : null

  let rows: Record<string, unknown>[] = []
  let columns: ExportColumn[] = []
  let title = ''
  let sheetName = ''
  let totals: Record<string, unknown> | undefined
  let freezeColumns = 0
  let filename = 'export.xlsx'

  try {
    switch (type) {

      // ── 1. All Classes Report ──────────────────────────────────────────────
      case 'all-classes': {
        filename = `lingualink-all-classes-${Date.now()}.xlsx`
        title = 'All Classes Report'
        sheetName = 'All Classes'
        freezeColumns = 2 // Date + Time stay visible when scrolling right

        const dateHeader = `Date (${exportTzLabel})`
        const timeHeader = `Time (${exportTzLabel})`

        columns = [
          { header: dateHeader, key: dateHeader, width: 14 },
          { header: timeHeader, key: timeHeader, width: 14 },
          { header: 'Teacher', key: 'Teacher', width: 24 },
          { header: 'Student', key: 'Student', width: 24 },
          { header: 'Company', key: 'Company', width: 24 },
          { header: 'Duration (min)', key: 'Duration (min)', width: 14, format: 'integer' },
          { header: 'Status', key: 'Status', width: 22 },
          { header: 'Report Status', key: 'Report Status', width: 22 },
          { header: 'Billable to Teacher', key: 'Billable to Teacher', width: 20 },
          { header: 'Cancellation Reason', key: 'Cancellation Reason', width: 45, wrap: true },
        ]

        let query = supabase
          .from('lessons')
          .select(`
            id, scheduled_at, duration_minutes, status,
            cancelled_at, cancellation_reason, cancelled_by, rescheduled_by,
            teacher_id, student_id, training_id
          `)
          .order('scheduled_at', { ascending: false })

        if (fromTs) query = query.gte('scheduled_at', fromTs)
        if (toTs)   query = query.lte('scheduled_at', toTs)
        if (teacherId) query = query.eq('teacher_id', teacherId)
        if (studentId) query = query.eq('student_id', studentId)

        const { data: lessons, error } = await query
        if (error) throw error

        // Batch-fetch teacher profiles and students
        const teacherIds = [...new Set((lessons ?? []).map((l: any) => l.teacher_id).filter(Boolean))]
        const studentIds = [...new Set((lessons ?? []).map((l: any) => l.student_id).filter(Boolean))]

        const [teacherRes, studentRes, reportRes] = await Promise.all([
          supabase.from('profiles').select('id, full_name').in('id', teacherIds),
          supabase.from('students').select('id, full_name, company_id').in('id', studentIds),
          supabase.from('reports').select('lesson_id, status, did_class_happen, no_show_type').in('lesson_id', (lessons ?? []).map((l: any) => l.id)),
        ])
        if (teacherRes.error) throw teacherRes.error
        if (studentRes.error) throw studentRes.error
        if (reportRes.error) throw reportRes.error

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const studentMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        const companyIds = [...new Set(Object.values(studentMap).map(s => s.companyId).filter(Boolean))] as string[]
        const companyRes = companyIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', companyIds)
          : { data: [] }
        if ('error' in companyRes && companyRes.error) throw companyRes.error
        const companyMap: Record<string, string> = {}
        companyRes.data?.forEach((c: any) => { companyMap[c.id] = c.name })

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        // Filter by company if requested
        const filtered = companyId
          ? (lessons ?? []).filter((l: any) => studentMap[l.student_id]?.companyId === companyId)
          : (lessons ?? [])

        rows = filtered.map((l: any) => {
          const report = reportMap[l.id]
          const student = studentMap[l.student_id]
          const billable = getBillability({
            status: l.status,
            scheduledAt: l.scheduled_at,
            cancelledAt: l.cancelled_at,
            cancellationPolicy: null, // teacher pay is independent of the 48hr company policy (brief 9.4)
            hourlyRate: 0,            // amount unused here — this export only shows Yes/No
            durationMinutes: l.duration_minutes ?? 0,
            cancelledBy: l.cancelled_by ?? null,
            rescheduledBy: l.rescheduled_by ?? null,
          }).billableToTeacher

          // Cancellation-family wording (incl. reschedule-leg attribution) from the shared
          // helper, mirroring the reports export so both admin exports read identically.
          // Non-cancel labels are export-specific and match reports/export/route.ts verbatim.
          const st = l.status as string
          const cancelLabel = getCancellationLabel(
            { status: st, cancelled_by: l.cancelled_by, rescheduled_by: l.rescheduled_by },
            'admin'
          )
          let statusLabel: string
          if (cancelLabel !== null) statusLabel = cancelLabel
          else if (st === 'completed') statusLabel = 'Taken'
          else if (st === 'student_no_show') statusLabel = 'Student No-Show'
          else if (st === 'teacher_no_show') statusLabel = 'Teacher No-Show'
          else if (st === 'scheduled') statusLabel = 'Scheduled'
          else if (st === 'missed') statusLabel = 'Missed'
          else statusLabel = st

          return {
            [dateHeader]: formatDateInTz(l.scheduled_at, exportTz),
            [timeHeader]: formatInstantInTz(l.scheduled_at, exportTz).slice(11),
            'Teacher': teacherMap[l.teacher_id] ?? '',
            'Student': student?.name ?? '',
            'Company': student?.companyId ? companyMap[student.companyId] ?? '' : 'Private',
            'Duration (min)': l.duration_minutes,
            'Status': statusLabel,
            'Report Status': report?.status ?? 'no report',
            'Billable to Teacher': billable ? 'Yes' : 'No',
            'Cancellation Reason': l.cancellation_reason ?? '',
          }
        })

        break
      }

      // ── 2. Teacher Earnings Summary ────────────────────────────────────────
      case 'teacher-earnings': {
        filename = `lingualink-teacher-earnings-${Date.now()}.xlsx`
        title = 'Teacher Earnings Summary'
        sheetName = 'Teacher Earnings'
        freezeColumns = 1 // Teacher stays visible

        columns = [
          { header: 'Teacher', key: 'Teacher', width: 24 },
          { header: 'Month', key: 'Month', width: 12 },
          { header: 'Classes Taken', key: 'Classes Taken', width: 14, format: 'integer' },
          { header: 'Student No-Shows', key: 'Student No-Shows', width: 18, format: 'integer' },
          { header: 'Total Hours', key: 'Total Hours', width: 14, format: 'decimal2' },
          { header: 'Hourly Rate', key: 'Hourly Rate', width: 14, format: 'money2' },
          { header: 'Total Owed', key: 'Total Owed', width: 14, format: 'money2' },
          { header: 'Currency', key: 'Currency', width: 10 },
          { header: 'Invoice Status', key: 'Invoice Status', width: 18 },
        ]

        // fromDate/toDate feed TWO consumers with different strictness: Date.parse
        // for the coarse UTC bound (lenient — it accepts 'YYYY-MM' and 'YYYY') and a
        // 10-char lexical day-key compare below (strict). A value that is valid to
        // the first and not the second passes the DB bound then rejects every day
        // key, silently emitting an EMPTY earnings sheet. Reject it loudly instead —
        // the admin UI's <input type="date"> always sends YYYY-MM-DD.
        const DAY_PARAM = /^\d{4}-\d{2}-\d{2}$/
        if ((fromDate && !DAY_PARAM.test(fromDate)) || (toDate && !DAY_PARAM.test(toDate))) {
          return NextResponse.json(
            { error: 'INVALID_DATE_RANGE', message: 'from/to must be YYYY-MM-DD.' },
            { status: 400 }
          )
        }

        let lessonsQuery = supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by, teacher_id')
          .neq('status', 'scheduled') // only settled lessons
          .order('scheduled_at', { ascending: false })

        // Coarse DB window only: widened by 1 day each side so a lesson that is
        // inside the range on a teacher's LOCAL calendar can never be excluded by
        // the UTC query bound (max real-world offset is UTC+14/-12). The exact
        // per-teacher-local filter below is the authoritative range check.
        if (fromDate) lessonsQuery = lessonsQuery.gte('scheduled_at', new Date(Date.parse(`${fromDate}T00:00:00.000Z`) - 86400000).toISOString())
        if (toDate)   lessonsQuery = lessonsQuery.lte('scheduled_at', new Date(Date.parse(`${toDate}T23:59:59.999Z`) + 86400000).toISOString())
        if (teacherId) lessonsQuery = lessonsQuery.eq('teacher_id', teacherId)

        const { data: lessons, error: lErr } = await lessonsQuery
        if (lErr) throw lErr

        const lessonIds = (lessons ?? []).map((l: any) => l.id)
        const tIds = [...new Set((lessons ?? []).map((l: any) => l.teacher_id).filter(Boolean))]

        // hourly_rate has a column-level REVOKE on `authenticated` — must use
        // the admin client. Role check above has already gated access here.
        const adminClient = createAdminClient()
        const [reportRes, profileRes] = await Promise.all([
          lessonIds.length > 0
            ? supabase.from('reports').select('lesson_id, did_class_happen, no_show_type').in('lesson_id', lessonIds)
            : { data: [] },
          tIds.length > 0
            ? adminClient.from('profiles').select('id, full_name, hourly_rate, currency, timezone').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in reportRes && reportRes.error) throw reportRes.error
        if ('error' in profileRes && profileRes.error) throw profileRes.error

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        const profileMap: Record<string, { name: string; rate: number; currency: string; timezone: string | null }> = {}
        profileRes.data?.forEach((p: any) => { profileMap[p.id] = { name: p.full_name, rate: Number(p.hourly_rate ?? 0), currency: p.currency ?? 'EUR', timezone: p.timezone ?? null } })

        // Group by teacher × month
        type EarningKey = string
        const summary: Record<EarningKey, {
          teacher: string
          month: string
          classesTaken: number
          studentNoShows: number
          totalMinutes: number
          rates: Set<number>
          currency: string
          billableAmount: number
          invoiceUploaded: string
        }> = {}

        const missingTzTeachers = new Set<string>()

        // Per-lesson pay rate from lesson_rate_snapshots (adminClient — deny-all RLS).
        // profile.rate (live profiles.hourly_rate) is the fallback only (NEW268 D1).
        const rateMap = await fetchLessonRateMap(adminClient, lessonIds)

        for (const lesson of lessons ?? []) {
          const report = reportMap[lesson.id]
          const profile = profileMap[lesson.teacher_id]

          // Checked FIRST: the teacher's timezone now scopes the range as well as
          // the month bucket, so a lesson cannot be range-filtered without it.
          if (!profile?.timezone) {
            missingTzTeachers.add(lesson.teacher_id)
            continue
          }

          // Authoritative range check: the lesson's calendar day in the TEACHER's
          // own timezone — the same zone the month bucketing and the invoice
          // (recomputeAmounts.ts) use, so the export window and invoices.amount_eur
          // agree at month boundaries. YYYY-MM-DD compares lexically.
          const localDay = getDayKeyInTz(new Date(lesson.scheduled_at), profile.timezone)
          if (fromDate && localDay < fromDate) continue
          if (toDate && localDay > toDate) continue

          // Snapshot rate for this lesson, else the teacher's live rate (Decision A).
          // Resolved BEFORE the billable gate so getBillability is the single source
          // of truth for both the gate AND the per-lesson amount — mirrors the invoice
          // path (recomputeAmounts.ts), which resolves the rate for every prefiltered
          // lesson then reads getBillability(...).amount.
          const resolvedRate = resolveLessonRate(rateMap, lesson.id, profile?.rate ?? 0)
          const bill = getBillability({
            status: lesson.status,
            scheduledAt: lesson.scheduled_at,
            cancelledAt: lesson.cancelled_at,
            cancellationPolicy: null, // teacher pay is independent of the 48hr company policy (brief 9.4)
            hourlyRate: resolvedRate,
            durationMinutes: lesson.duration_minutes ?? 0,
            cancelledBy: lesson.cancelled_by ?? null,
            rescheduledBy: lesson.rescheduled_by ?? null,
          })
          if (!bill.billableToTeacher) continue

          // NEW271: Month buckets in the TEACHER's own timezone (matches NEW268 D3 /
          // recomputeAmounts.ts invoice basis). Display columns render in the export tz,
          // but the billing-period KEY is teacher-local so this sheet's Month/Total agree
          // with invoices.amount_eur and the invoice-status join keys correctly.
          // The from/to range scoping above now resolves in this same teacher-local
          // zone, so scoping and bucketing can no longer disagree at a boundary.
          const month = getMonthKeyInTz(new Date(lesson.scheduled_at), profile.timezone).slice(0, 7)
          const key = `${lesson.teacher_id}__${month}`

          if (!summary[key]) {
            summary[key] = {
              teacher: profile?.name ?? '',
              month,
              classesTaken: 0,
              studentNoShows: 0,
              totalMinutes: 0,
              rates: new Set<number>(),
              currency: profile?.currency ?? 'EUR',
              billableAmount: 0,
              invoiceUploaded: '',
            }
          }

          summary[key].classesTaken++
          if (report?.no_show_type === 'student') summary[key].studentNoShows++
          summary[key].totalMinutes += lesson.duration_minutes ?? 0
          // Sum the per-lesson amount ALREADY rounded to cents by getBillability
          // (Math.round(...*100)/100), so Total Owed equals the invoice amount_eur
          // for the same teacher-month instead of drifting by fractions of a cent.
          summary[key].billableAmount += bill.amount
          summary[key].rates.add(resolvedRate)
        }

        if (missingTzTeachers.size > 0) {
          return NextResponse.json(
            { error: 'TIMEZONE_MISSING', message: `Cannot export earnings: ${missingTzTeachers.size} teacher(s) have no timezone set. Set their timezones before exporting.` },
            { status: 422 }
          )
        }

        // Fetch invoice upload status per teacher/month
        // Service-role read — the route is requireAdmin-gated above.
        const invoiceRes = await adminClient.from('invoices').select('teacher_id, billing_month, status')
        if (invoiceRes.error) throw invoiceRes.error
        const invoiceMap: Record<string, string> = {}
        invoiceRes.data?.forEach((inv: any) => {
          const ym = (inv.billing_month as string).slice(0, 7)
          invoiceMap[`${inv.teacher_id}__${ym}`] = inv.status
        })

        const earningRows = Object.entries(summary).map(([key, s]) => ({
          'Teacher': s.teacher,
          'Month': s.month,
          'Classes Taken': s.classesTaken,
          'Student No-Shows': s.studentNoShows,
          'Total Hours': Number((s.totalMinutes / 60).toFixed(2)),
          // Decision B: one rate if every lesson in the teacher-month resolved to the
          // same rate, else "varies" (amounts above are per-lesson snapshot-correct).
          // 'varies' is deliberately a STRING in an otherwise numeric column.
          'Hourly Rate': s.rates.size === 0 ? 0 : s.rates.size === 1 ? [...s.rates][0] : 'varies',
          'Total Owed': Number(s.billableAmount.toFixed(2)),
          'Currency': s.currency,
          'Invoice Status': invoiceMap[key] ?? 'not uploaded',
        }))

        earningRows.sort((a, b) => a['Teacher'].localeCompare(b['Teacher']) || a['Month'].localeCompare(b['Month']))
        rows = earningRows

        if (earningRows.length > 0) {
          // Currency guard: money may only be summed within ONE currency. Counts and
          // hours are currency-independent and always sum.
          const currencies = [...new Set(earningRows.map(r => r['Currency']))]
          const owedSum = earningRows.reduce((sum, r) => sum + r['Total Owed'], 0)
          totals = {
            'Teacher': 'TOTAL',
            'Classes Taken': earningRows.reduce((sum, r) => sum + r['Classes Taken'], 0),
            'Student No-Shows': earningRows.reduce((sum, r) => sum + r['Student No-Shows'], 0),
            'Total Hours': Number(earningRows.reduce((sum, r) => sum + r['Total Hours'], 0).toFixed(2)),
            'Total Owed': currencies.length === 1 ? Number(owedSum.toFixed(2)) : 'Mixed currencies - see rows',
            ...(currencies.length === 1 ? { 'Currency': currencies[0] } : {}),
          }
        }

        break
      }

      // ── 3. Student Hours Usage ─────────────────────────────────────────────
      case 'student-hours': {
        filename = `lingualink-student-hours-${Date.now()}.xlsx`
        title = 'Student Hours Usage'
        sheetName = 'Student Hours'
        freezeColumns = 1 // Student stays visible

        columns = [
          { header: 'Student', key: 'Student', width: 24 },
          { header: 'Company', key: 'Company', width: 24 },
          { header: 'Package', key: 'Package', width: 28 },
          { header: 'Total Hours', key: 'Total Hours', width: 14, format: 'decimal2' },
          { header: 'Hours Used', key: 'Hours Used', width: 14, format: 'decimal2' },
          { header: 'Hours Remaining', key: 'Hours Remaining', width: 16, format: 'decimal2' },
          { header: 'Start Date', key: 'Start Date', width: 14 },
          { header: 'End Date', key: 'End Date', width: 14 },
          { header: 'Status', key: 'Status', width: 22 },
        ]

        // Service-role read — the route is requireAdmin-gated above.
        const adminClient = createAdminClient()

        let trainQuery = adminClient
          .from('trainings')
          .select('id, student_id, total_hours, hours_consumed, start_date, end_date, package_name, status')
          .order('created_at', { ascending: false })

        if (studentId) trainQuery = trainQuery.eq('student_id', studentId)

        const { data: trainings, error: tErr } = await trainQuery
        if (tErr) throw tErr

        const sIds = [...new Set((trainings ?? []).map((t: any) => t.student_id).filter(Boolean))]
        const studentRes = sIds.length > 0
          ? await supabase.from('students').select('id, full_name, company_id').in('id', sIds)
          : { data: [] }
        if ('error' in studentRes && studentRes.error) throw studentRes.error

        const sMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { sMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        const cIds = [...new Set(Object.values(sMap).map(s => s.companyId).filter(Boolean))] as string[]
        const cRes = cIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', cIds)
          : { data: [] }
        if ('error' in cRes && cRes.error) throw cRes.error
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        const filtered = companyId
          ? (trainings ?? []).filter((t: any) => sMap[t.student_id]?.companyId === companyId)
          : (trainings ?? [])

        rows = filtered.map((t: any) => {
          const student = sMap[t.student_id]
          const remaining = Number(t.total_hours) - Number(t.hours_consumed)
          return {
            'Student': student?.name ?? '',
            'Company': student?.companyId ? cMap[student.companyId] ?? '' : 'Private',
            'Package': t.package_name ?? t.package_type ?? '',
            'Total Hours': Number(Number(t.total_hours).toFixed(2)),
            'Hours Used': Number(Number(t.hours_consumed).toFixed(2)),
            'Hours Remaining': Number(remaining.toFixed(2)),
            'Start Date': formatDate(t.start_date),
            'End Date': formatDate(t.end_date),
            'Status': t.status,
          }
        })

        break
      }

      // ── 4. Company Billing Report ──────────────────────────────────────────
      case 'company-billing': {
        filename = `lingualink-company-billing-${Date.now()}.xlsx`
        title = 'Company Billing Report'
        sheetName = 'Company Billing'
        freezeColumns = 1 // Company stays visible

        const dateHeader = `Date (${exportTzLabel})`
        const timeHeader = `Time (${exportTzLabel})`

        columns = [
          { header: 'Company', key: 'Company', width: 24 },
          { header: 'Student', key: 'Student', width: 24 },
          { header: dateHeader, key: dateHeader, width: 14 },
          { header: timeHeader, key: timeHeader, width: 14 },
          { header: 'Duration (min)', key: 'Duration (min)', width: 14, format: 'integer' },
          { header: 'Status', key: 'Status', width: 22 },
          { header: 'Billable (standard)', key: 'Billable (standard)', width: 20 },
          { header: 'Billable cancellation (48hr policy)', key: 'Billable cancellation (48hr policy)', width: 36 },
          { header: 'Amount', key: 'Amount', width: 14, format: 'money2' },
          { header: 'Currency', key: 'Currency', width: 10 },
        ]

        // cancellation_policy has a column-level REVOKE on `authenticated` — must use
        // the admin client. Role check above has already gated access here.
        const adminClient = createAdminClient()

        // Get all B2B students (those with a company_id)
        let studentQuery = adminClient
          .from('students')
          .select('id, full_name, company_id, cancellation_policy')
          .not('company_id', 'is', null)

        if (companyId) studentQuery = studentQuery.eq('company_id', companyId)
        const { data: students, error: sErr } = await studentQuery
        if (sErr) throw sErr

        const studentIds = (students ?? []).map((s: any) => s.id)
        // No B2B students in scope — emit the empty workbook (title block + headers).
        if (studentIds.length === 0) break

        const cIds = [...new Set((students ?? []).map((s: any) => s.company_id).filter(Boolean))] as string[]
        const cRes = await supabase.from('companies').select('id, name').in('id', cIds)
        if (cRes.error) throw cRes.error
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        let lessonsQuery = supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by, student_id, teacher_id')
          .in('student_id', studentIds)
          .order('scheduled_at', { ascending: false })

        if (fromTs) lessonsQuery = lessonsQuery.gte('scheduled_at', fromTs)
        if (toTs)   lessonsQuery = lessonsQuery.lte('scheduled_at', toTs)

        const { data: lessons, error: lErr } = await lessonsQuery
        if (lErr) throw lErr

        // hourly_rate has a column-level REVOKE on `authenticated` — fetch the
        // teacher rate+currency via the admin client (role-gated above) so the
        // company-owed Amount can be computed from getBillability's single source.
        const teacherIds = [...new Set((lessons ?? []).map((l: any) => l.teacher_id).filter(Boolean))] as string[]
        const teacherRes = teacherIds.length > 0
          ? await adminClient.from('profiles').select('id, hourly_rate, currency').in('id', teacherIds)
          : { data: [] }
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error
        const teacherMap: Record<string, { rate: number; currency: string }> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = { rate: Number(p.hourly_rate ?? 0), currency: p.currency ?? 'EUR' } })

        // Per-lesson pay rate from lesson_rate_snapshots (adminClient — deny-all RLS).
        // teacherMap rate (live profiles.hourly_rate) is the fallback only (NEW268 D1).
        const rateMap = await fetchLessonRateMap(adminClient, (lessons ?? []).map((l: { id: string }) => l.id))

        const sMap: Record<string, any> = {}
        students?.forEach((s: any) => { sMap[s.id] = s })

        const billingRows = (lessons ?? []).map((l: any) => {
          const student = sMap[l.student_id]

          // company-standard billing intentionally tracks billableToTeacher; the 48hr B2B split is billable48hr — single source of truth, do not reintroduce inline arithmetic.
          const bill = getBillability({
            status: l.status,
            scheduledAt: l.scheduled_at,
            cancelledAt: l.cancelled_at,
            cancellationPolicy: student?.cancellation_policy as '24hr' | '48hr' | null,
            hourlyRate: resolveLessonRate(rateMap, l.id, teacherMap[l.teacher_id]?.rate ?? 0),
            durationMinutes: l.duration_minutes ?? 0,
            cancelledBy: l.cancelled_by ?? null,
            rescheduledBy: l.rescheduled_by ?? null,
          })
          const billable24 = bill.billableToTeacher
          const billable48 = bill.billable48hr

          // Cancellation-family wording (incl. reschedule-leg attribution) from the shared
          // helper, mirroring the all-classes export so both admin exports read identically.
          // Display-only: getBillability above still keys off the raw l.status.
          const st = l.status as string
          const cancelLabel = getCancellationLabel(
            { status: st, cancelled_by: l.cancelled_by, rescheduled_by: l.rescheduled_by },
            'admin'
          )
          let statusLabel: string
          if (cancelLabel !== null) statusLabel = cancelLabel
          else if (st === 'completed') statusLabel = 'Taken'
          else if (st === 'student_no_show') statusLabel = 'Student No-Show'
          else if (st === 'teacher_no_show') statusLabel = 'Teacher No-Show'
          else if (st === 'scheduled') statusLabel = 'Scheduled'
          else if (st === 'missed') statusLabel = 'Missed'
          else statusLabel = st

          return {
            'Company': student?.company_id ? cMap[student.company_id] ?? '' : '',
            'Student': student?.full_name ?? '',
            [dateHeader]: formatDateInTz(l.scheduled_at, exportTz),
            [timeHeader]: formatInstantInTz(l.scheduled_at, exportTz).slice(11),
            'Duration (min)': l.duration_minutes,
            'Status': statusLabel,
            'Billable (standard)': billable24 ? 'Yes' : 'No',
            'Billable cancellation (48hr policy)': billable48 ? 'Yes' : 'No',
            'Amount': bill.companyAmount,
            'Currency': teacherMap[l.teacher_id]?.currency ?? 'EUR',
          }
        })

        rows = billingRows

        if (billingRows.length > 0) {
          // Currency guard: money may only be summed within ONE currency.
          const currencies = [...new Set(billingRows.map((r: any) => r['Currency'] as string))]
          const amountSum = billingRows.reduce((sum: number, r: any) => sum + Number(r['Amount'] ?? 0), 0)
          totals = {
            'Company': 'TOTAL',
            'Amount': currencies.length === 1 ? Number(amountSum.toFixed(2)) : 'Mixed currencies - see rows',
            ...(currencies.length === 1 ? { 'Currency': currencies[0] } : {}),
          }
        }

        break
      }

      // ── 5. Student Progress Report ─────────────────────────────────────────
      case 'student-progress': {
        filename = `lingualink-student-progress-${Date.now()}.xlsx`
        title = 'Student Progress Report'
        sheetName = 'Student Progress'
        freezeColumns = 1 // Student stays visible

        const classDateHeader = `Class Date (${exportTzLabel})`

        columns = [
          { header: 'Student', key: 'Student', width: 24 },
          { header: classDateHeader, key: classDateHeader, width: 20 },
          { header: 'Teacher', key: 'Teacher', width: 24 },
          { header: 'Grammar', key: 'Grammar', width: 14 },
          { header: 'Expression', key: 'Expression', width: 14 },
          { header: 'Comprehension', key: 'Comprehension', width: 16 },
          { header: 'Vocabulary', key: 'Vocabulary', width: 14 },
          { header: 'Accent', key: 'Accent', width: 12 },
          { header: 'Overall Spoken Level', key: 'Overall Spoken Level', width: 22 },
          { header: 'Overall Written Level', key: 'Overall Written Level', width: 22 },
        ]

        let reportsQuery = supabase
          .from('reports')
          .select('id, lesson_id, teacher_id, level_data, completed_at')
          .eq('did_class_happen', true)
          .not('level_data', 'is', null)
          .order('completed_at', { ascending: false })

        if (fromTs) reportsQuery = reportsQuery.gte('completed_at', fromTs)
        if (toTs)   reportsQuery = reportsQuery.lte('completed_at', toTs)
        if (teacherId) reportsQuery = reportsQuery.eq('teacher_id', teacherId)

        const { data: reports, error: rErr } = await reportsQuery
        if (rErr) throw rErr

        const lessonIds = (reports ?? []).map((r: any) => r.lesson_id).filter(Boolean)
        const tIds = [...new Set((reports ?? []).map((r: any) => r.teacher_id).filter(Boolean))]

        const [lessonRes, teacherRes] = await Promise.all([
          lessonIds.length > 0
            ? supabase.from('lessons').select('id, student_id, scheduled_at').in('id', lessonIds)
            : { data: [] },
          tIds.length > 0
            ? supabase.from('profiles').select('id, full_name').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in lessonRes && lessonRes.error) throw lessonRes.error
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))]
        const filteredSIds = studentId ? [studentId] : sIds as string[]

        const studentRes2 = filteredSIds.length > 0
          ? await supabase.from('students').select('id, full_name').in('id', filteredSIds)
          : { data: [] }
        if ('error' in studentRes2 && studentRes2.error) throw studentRes2.error
        const studentMap: Record<string, string> = {}
        studentRes2.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        rows = []

        for (const report of reports ?? []) {
          const lesson = lessonMap[report.lesson_id]
          if (!lesson) continue
          if (studentId && lesson.studentId !== studentId) continue

          const ld = report.level_data as Record<string, string> | null
          if (!ld) continue

          rows.push({
            'Student': studentMap[lesson.studentId] ?? '',
            [classDateHeader]: lesson.scheduledAt ? formatDateInTz(lesson.scheduledAt, exportTz) : '',
            'Teacher': teacherMap[report.teacher_id] ?? '',
            'Grammar': ld.grammar ?? '',
            'Expression': ld.expression ?? '',
            'Comprehension': ld.comprehension ?? '',
            'Vocabulary': ld.vocabulary ?? '',
            'Accent': ld.accent ?? '',
            'Overall Spoken Level': ld.overall_spoken ?? '',
            'Overall Written Level': ld.overall_written ?? '',
          })
        }

        break
      }

      // ── 6. Pending Reports Log ─────────────────────────────────────────────
      case 'pending-reports': {
        filename = `lingualink-pending-reports-${Date.now()}.xlsx`
        title = 'Pending Reports Log'
        sheetName = 'Pending Reports'
        freezeColumns = 1 // Teacher stays visible

        const classDateHeader = `Class Date (${exportTzLabel})`
        const deadlineHeader = `Deadline (${exportTzLabel})`
        const flaggedAtHeader = `Flagged At (${exportTzLabel})`

        columns = [
          { header: 'Teacher', key: 'Teacher', width: 24 },
          { header: 'Student', key: 'Student', width: 24 },
          { header: classDateHeader, key: classDateHeader, width: 20 },
          { header: 'Hours Since Class', key: 'Hours Since Class', width: 18, format: 'decimal2' },
          { header: 'Report Status', key: 'Report Status', width: 22 },
          { header: deadlineHeader, key: deadlineHeader, width: 20 },
          { header: flaggedAtHeader, key: flaggedAtHeader, width: 20 },
        ]

        let query = supabase
          .from('reports')
          .select('id, lesson_id, teacher_id, status, flagged_at, deadline_at, created_at')
          .in('status', ['pending', 'flagged', 'reopened'])
          .order('created_at', { ascending: false })

        if (fromTs) query = query.gte('created_at', fromTs)
        if (toTs)   query = query.lte('created_at', toTs)
        if (teacherId) query = query.eq('teacher_id', teacherId)

        const { data: reports, error: rErr } = await query
        if (rErr) throw rErr

        const lessonIds = (reports ?? []).map((r: any) => r.lesson_id).filter(Boolean)
        const tIds = [...new Set((reports ?? []).map((r: any) => r.teacher_id).filter(Boolean))]

        const [lessonRes, teacherRes] = await Promise.all([
          lessonIds.length > 0
            ? supabase.from('lessons').select('id, student_id, scheduled_at').in('id', lessonIds)
            : { data: [] },
          tIds.length > 0
            ? supabase.from('profiles').select('id, full_name').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in lessonRes && lessonRes.error) throw lessonRes.error
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))] as string[]
        const studentRes = sIds.length > 0
          ? await supabase.from('students').select('id, full_name').in('id', sIds)
          : { data: [] }
        if ('error' in studentRes && studentRes.error) throw studentRes.error
        const studentMap: Record<string, string> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        const now = Date.now()

        rows = (reports ?? []).map((r: any) => {
          const lesson = lessonMap[r.lesson_id]
          const classEndTime = lesson
            ? new Date(lesson.scheduledAt).getTime()
            : null
          // Number, not a string — sorts and filters in Excel. No lesson row leaves
          // the cell EMPTY (never 0, which would read as "reported on time").
          const hoursSinceClass = classEndTime
            ? Number(((now - classEndTime) / (1000 * 60 * 60)).toFixed(1))
            : ''

          return {
            'Teacher': teacherMap[r.teacher_id] ?? '',
            'Student': lesson ? studentMap[lesson.studentId] ?? '' : '',
            [classDateHeader]: lesson ? formatInstantInTz(lesson.scheduledAt, exportTz) : '',
            'Hours Since Class': hoursSinceClass,
            'Report Status': r.status,
            [deadlineHeader]: r.deadline_at ? formatInstantInTz(r.deadline_at, exportTz) : '',
            [flaggedAtHeader]: r.flagged_at ? formatInstantInTz(r.flagged_at, exportTz) : '',
          }
        })

        break
      }

      default:
        return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
    }
  } catch (err: any) {
    console.error(`Export error [${type}]:`, err)
    Sentry.captureException(err)
    return NextResponse.json({ error: err.message ?? 'Export failed' }, { status: 500 })
  }

  const filterLines = await buildFilterLines(supabase, { fromDate, toDate, teacherId, studentId, companyId })

  const buffer = await buildExportWorkbook({
    title,
    columns,
    rows,
    generatedAtLabel: formatInstantInTz(new Date(), exportTz),
    timezoneLabel: exportTzLabel,
    filterLines,
    sheetName,
    totalsRow: totals,
    freezeColumns,
  })

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
