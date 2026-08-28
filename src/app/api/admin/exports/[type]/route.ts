import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { getBillability } from '@/lib/billing/billability'
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates'
import { getDayKeyInTz, getMonthKeyInTz } from '@/lib/billing/monthRange'
import { getExportTimezone, formatInstantInTz, formatDateInTz, tzLabel } from '@/lib/exportTime'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { buildFilterLines } from '@/lib/exports/filterLines'
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
          // Proof columns: what the system actually recorded, for dispute resolution.
          // Every timestamp below renders in exportTz via fmtInstant (defined lower).
          { header: 'Class ID', key: 'Class ID', width: 38 },
          { header: 'Booked At', key: 'Booked At', width: 18 },
          { header: 'Cancelled At', key: 'Cancelled At', width: 18 },
          { header: 'Cancelled By', key: 'Cancelled By', width: 14 },
          { header: 'Hours Refunded', key: 'Hours Refunded', width: 16 },
          { header: 'Cancellation Window', key: 'Cancellation Window', width: 20 },
          { header: 'Rescheduled At', key: 'Rescheduled At', width: 18 },
          { header: 'Teacher Joined At', key: 'Teacher Joined At', width: 18 },
          { header: 'Student Joined At', key: 'Student Joined At', width: 18 },
          { header: 'Teams Link Created', key: 'Teams Link Created', width: 18 },
          { header: 'Report Deadline', key: 'Report Deadline', width: 18 },
          { header: 'Report Submitted At', key: 'Report Submitted At', width: 18 },
          { header: 'Report Flagged At', key: 'Report Flagged At', width: 18 },
        ]

        let query = supabase
          .from('lessons')
          .select(`
            id, scheduled_at, duration_minutes, status,
            cancelled_at, cancellation_reason, cancelled_by, rescheduled_by, hours_refunded,
            teacher_id, student_id, training_id,
            created_at, rescheduled_at, teams_join_url
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

        // lesson_join_clicks is deny-all RLS with `revoke all ... from anon,
        // authenticated` (migration 20260707120000, lines 40-41), so the anon-key
        // `supabase` client returns 42501 on it — the join-proof columns must read
        // through the service-role client, the same way reports/export/route.ts
        // reaches this table. requireAdmin() above has already gated access.
        const joinClickClient = createAdminClient()
        const [teacherRes, studentRes, reportRes, joinClickRes] = await Promise.all([
          supabase.from('profiles').select('id, full_name, is_test').in('id', teacherIds),
          supabase.from('students').select('id, full_name, company_id, is_test').in('id', studentIds),
          supabase.from('reports').select('lesson_id, status, did_class_happen, no_show_type, deadline_at, completed_at, flagged_at').in('lesson_id', (lessons ?? []).map((l: any) => l.id)),
          joinClickClient.from('lesson_join_clicks').select('lesson_id, user_type, clicked_at').in('lesson_id', (lessons ?? []).map((l: any) => l.id)),
        ])
        if (teacherRes.error) throw teacherRes.error
        if (studentRes.error) throw studentRes.error
        if (reportRes.error) throw reportRes.error
        if (joinClickRes.error) throw joinClickRes.error

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const studentMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        // Test accounts (profiles.is_test / students.is_test) never reach an export.
        // Built as id sets so the name/company maps above keep their existing shape.
        const testTeacherIds = new Set<string>()
        teacherRes.data?.forEach((p: any) => { if (p.is_test) testTeacherIds.add(p.id) })
        const testStudentIds = new Set<string>()
        studentRes.data?.forEach((s: any) => { if (s.is_test) testStudentIds.add(s.id) })

        const companyIds = [...new Set(Object.values(studentMap).map(s => s.companyId).filter(Boolean))] as string[]
        const companyRes = companyIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', companyIds)
          : { data: [] }
        if ('error' in companyRes && companyRes.error) throw companyRes.error
        const companyMap: Record<string, string> = {}
        companyRes.data?.forEach((c: any) => { companyMap[c.id] = c.name })

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        // lesson_id -> every recorded join click for it. A lesson with no clicks
        // resolves to an empty array below, never undefined.
        const joinClickMap: Record<string, { user_type: string; clicked_at: string }[]> = {}
        joinClickRes.data?.forEach((c: any) => {
          if (!joinClickMap[c.lesson_id]) joinClickMap[c.lesson_id] = []
          joinClickMap[c.lesson_id].push({ user_type: c.user_type, clicked_at: c.clicked_at })
        })

        // Null-safe wrapper around the instant formatter this branch already uses
        // for scheduled_at. Same formatter, same exportTz; a null timestamptz
        // renders as an empty cell — never 'null', never 'Invalid Date'.
        const fmtInstant = (value: string | null | undefined): string =>
          value ? formatInstantInTz(value, exportTz) : ''

        // A lesson is dropped when EITHER side of it is a test account. Applied
        // before the company filter below, which is left exactly as it was.
        const realLessons = (lessons ?? []).filter(
          (l: any) => !testTeacherIds.has(l.teacher_id) && !testStudentIds.has(l.student_id)
        )

        // Filter by company if requested
        const filtered = companyId
          ? realLessons.filter((l: any) => studentMap[l.student_id]?.companyId === companyId)
          : realLessons

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

          // Refund outcome belongs on the Status cell so it reads like the old LearnCube
          // Past Classes export. Only TRUE cancellations carry it. Reschedule legs
          // (rescheduled_by set) move the hours to the new booking and refund nothing, so
          // they keep the plain "Rescheduled by ..." label. Display only - getBillability
          // above is untouched and does not read hours_refunded.
          const isRescheduleLeg = l.rescheduled_by === 'student' || l.rescheduled_by === 'admin'
          if (cancelLabel !== null && !isRescheduleLeg) {
            statusLabel = `${statusLabel} - ${l.hours_refunded ? 'refunded' : 'not refunded'}`
          }

          // Earliest join click per user_type. Logic DUPLICATED from
          // api/admin/reports/export/route.ts:252-268, where it is a local closure
          // and not exported; adapted to the flat array built above because this
          // route queries lesson_join_clicks directly rather than via a nested join.
          const clicks = joinClickMap[l.id] ?? []
          const earliest = (userType: string): string | null => {
            const times = clicks
              .filter((c) => c.user_type === userType)
              .map((c) => c.clicked_at as string)
              .filter(Boolean)
            if (!times.length) return null
            return times.reduce((min: string, t: string) =>
              new Date(t).getTime() < new Date(min).getTime() ? t : min
            )
          }
          const teacherJoinedAt = earliest('teacher')
          const studentJoinedAt = earliest('student')

          // Cancellation window: absolute-instant gap between schedule and
          // cancellation, so it is timezone-independent. DISPLAY ONLY — no money
          // column is derived from it and getBillability above is untouched.
          let cancellationWindow = ''
          if (l.cancelled_at) {
            const windowHours = (new Date(l.scheduled_at).getTime() - new Date(l.cancelled_at).getTime()) / 3600000
            if (windowHours < 24) cancellationWindow = '<24hr'
            else if (windowHours < 48) cancellationWindow = '24-48hr'
            else cancellationWindow = '>48hr'
          }

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
            'Class ID': l.id,
            'Booked At': fmtInstant(l.created_at),
            'Cancelled At': fmtInstant(l.cancelled_at),
            // RAW recorded value (live values are role words such as 'student'),
            // deliberately NOT passed through getCancellationLabel and not derived
            // from status — this column has to prove what was stored.
            'Cancelled By': l.cancelled_by ?? '',
            'Hours Refunded': l.hours_refunded ? 'Yes' : 'No',
            'Cancellation Window': cancellationWindow,
            'Rescheduled At': fmtInstant(l.rescheduled_at),
            'Teacher Joined At': fmtInstant(teacherJoinedAt),
            'Student Joined At': fmtInstant(studentJoinedAt),
            'Teams Link Created': typeof l.teams_join_url === 'string' && l.teams_join_url.length > 0 ? 'Yes' : 'No',
            'Report Deadline': fmtInstant(report?.deadline_at),
            'Report Submitted At': fmtInstant(report?.completed_at),
            'Report Flagged At': fmtInstant(report?.flagged_at),
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
            ? adminClient.from('profiles').select('id, full_name, hourly_rate, currency, timezone, is_test').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in reportRes && reportRes.error) throw reportRes.error
        if ('error' in profileRes && profileRes.error) throw profileRes.error

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        const profileMap: Record<string, { name: string; rate: number; currency: string; timezone: string | null }> = {}
        profileRes.data?.forEach((p: any) => { profileMap[p.id] = { name: p.full_name, rate: Number(p.hourly_rate ?? 0), currency: p.currency ?? 'EUR', timezone: p.timezone ?? null } })

        // Test teachers (profiles.is_test) never reach an export. No students fetch is
        // added here: test students only ever have lessons with test teachers (verified
        // in DB 28 Aug 2026), so excluding the teacher side covers them.
        const testTeacherIds = new Set<string>()
        profileRes.data?.forEach((p: any) => { if (p.is_test) testTeacherIds.add(p.id) })

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

          // Test-teacher exclusion sits ABOVE the timezone guard on purpose: a test
          // account with no timezone set must not 422 an otherwise valid export.
          if (testTeacherIds.has(lesson.teacher_id)) continue

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
          ? await supabase.from('students').select('id, full_name, company_id, is_test').in('id', sIds)
          : { data: [] }
        if ('error' in studentRes && studentRes.error) throw studentRes.error

        const sMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { sMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        // Test students (students.is_test) never reach an export.
        const testStudentIds = new Set<string>()
        studentRes.data?.forEach((s: any) => { if (s.is_test) testStudentIds.add(s.id) })

        const cIds = [...new Set(Object.values(sMap).map(s => s.companyId).filter(Boolean))] as string[]
        const cRes = cIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', cIds)
          : { data: [] }
        if ('error' in cRes && cRes.error) throw cRes.error
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        // Applied before the company filter below, which is left exactly as it was.
        const realTrainings = (trainings ?? []).filter((t: any) => !testStudentIds.has(t.student_id))

        const filtered = companyId
          ? realTrainings.filter((t: any) => sMap[t.student_id]?.companyId === companyId)
          : realTrainings

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
          { header: 'Teacher', key: 'Teacher', width: 24 },
          { header: dateHeader, key: dateHeader, width: 14 },
          { header: timeHeader, key: timeHeader, width: 14 },
          { header: 'Duration (min)', key: 'Duration (min)', width: 14, format: 'integer' },
          { header: 'Status', key: 'Status', width: 22 },
          { header: 'Billable (standard)', key: 'Billable (standard)', width: 20 },
          { header: 'Billable cancellation (48hr policy)', key: 'Billable cancellation (48hr policy)', width: 36 },
          { header: 'Amount', key: 'Amount', width: 14, format: 'money2' },
          { header: 'Currency', key: 'Currency', width: 10 },
          { header: 'Hourly Rate', key: 'Hourly Rate', width: 14, format: 'money2' },
          { header: 'Amount Owed to Teacher', key: 'Amount Owed to Teacher', width: 24, format: 'money2' },
          // Proof columns: what the system actually recorded, for dispute resolution.
          // Every timestamp below renders in exportTz via fmtInstant (defined lower).
          // Deliberately absent from the totals block — they render blank there.
          { header: 'Class ID', key: 'Class ID', width: 38 },
          { header: 'Booked At', key: 'Booked At', width: 18 },
          { header: 'Cancelled At', key: 'Cancelled At', width: 18 },
          { header: 'Cancelled By', key: 'Cancelled By', width: 14 },
          { header: 'Hours Refunded', key: 'Hours Refunded', width: 16 },
          { header: 'Cancellation Window', key: 'Cancellation Window', width: 20 },
          { header: 'Cancellation Reason', key: 'Cancellation Reason', width: 45, wrap: true },
          { header: 'Rescheduled At', key: 'Rescheduled At', width: 18 },
          { header: 'Teacher Joined At', key: 'Teacher Joined At', width: 18 },
          { header: 'Student Joined At', key: 'Student Joined At', width: 18 },
          { header: 'Teams Link Created', key: 'Teams Link Created', width: 18 },
          { header: 'Report Deadline', key: 'Report Deadline', width: 18 },
          { header: 'Report Submitted At', key: 'Report Submitted At', width: 18 },
          { header: 'Report Flagged At', key: 'Report Flagged At', width: 18 },
        ]

        // cancellation_policy has a column-level REVOKE on `authenticated` — must use
        // the admin client. Role check above has already gated access here.
        const adminClient = createAdminClient()

        // Get all B2B students (those with a company_id)
        let studentQuery = adminClient
          .from('students')
          .select('id, full_name, company_id, cancellation_policy, is_test')
          .not('company_id', 'is', null)

        if (companyId) studentQuery = studentQuery.eq('company_id', companyId)
        const { data: students, error: sErr } = await studentQuery
        if (sErr) throw sErr

        // Test students (students.is_test) never reach an export. Dropped here, before
        // studentIds is built, so the lessons query below cannot fetch their classes.
        const realStudents = (students ?? []).filter((s: any) => !s.is_test)

        const studentIds = realStudents.map((s: any) => s.id)
        // No B2B students in scope — emit the empty workbook (title block + headers).
        if (studentIds.length === 0) break

        const cIds = [...new Set(realStudents.map((s: any) => s.company_id).filter(Boolean))] as string[]
        const cRes = await supabase.from('companies').select('id, name').in('id', cIds)
        if (cRes.error) throw cRes.error
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        let lessonsQuery = supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by, hours_refunded, student_id, teacher_id, cancellation_reason, rescheduled_at, created_at, teams_join_url')
          .in('student_id', studentIds)
          .order('scheduled_at', { ascending: false })

        if (fromTs) lessonsQuery = lessonsQuery.gte('scheduled_at', fromTs)
        if (toTs)   lessonsQuery = lessonsQuery.lte('scheduled_at', toTs)

        const { data: lessons, error: lErr } = await lessonsQuery
        if (lErr) throw lErr

        // Proof-column reads, both through the `adminClient` already open above.
        // lesson_join_clicks is deny-all RLS with `revoke all ... from anon,
        // authenticated` (migration 20260707120000), so the anon-key `supabase`
        // client returns 42501 on it and would 500 the whole export. requireAdmin()
        // at the top of this handler has already gated access.
        const lessonIds = (lessons ?? []).map((l: any) => l.id)
        const [reportRes, joinClickRes] = await Promise.all([
          adminClient.from('reports').select('lesson_id, deadline_at, completed_at, flagged_at').in('lesson_id', lessonIds),
          adminClient.from('lesson_join_clicks').select('lesson_id, user_type, clicked_at').in('lesson_id', lessonIds),
        ])
        if (reportRes.error) throw reportRes.error
        if (joinClickRes.error) throw joinClickRes.error

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        // lesson_id -> every recorded join click for it. A lesson with no clicks
        // resolves to an empty array below, never undefined.
        const joinClickMap: Record<string, { user_type: string; clicked_at: string }[]> = {}
        joinClickRes.data?.forEach((c: any) => {
          if (!joinClickMap[c.lesson_id]) joinClickMap[c.lesson_id] = []
          joinClickMap[c.lesson_id].push({ user_type: c.user_type, clicked_at: c.clicked_at })
        })

        // Null-safe wrapper around the instant formatter this branch already uses
        // for scheduled_at. Same formatter, same exportTz; a null timestamptz
        // renders as an empty cell — never 'null', never 'Invalid Date'.
        const fmtInstant = (value: string | null | undefined): string =>
          value ? formatInstantInTz(value, exportTz) : ''

        // hourly_rate has a column-level REVOKE on `authenticated` — fetch the
        // teacher rate+currency via the admin client (role-gated above) so the
        // company-owed Amount can be computed from getBillability's single source.
        const teacherIds = [...new Set((lessons ?? []).map((l: any) => l.teacher_id).filter(Boolean))] as string[]
        const teacherRes = teacherIds.length > 0
          ? await adminClient.from('profiles').select('id, full_name, hourly_rate, currency, is_test').in('id', teacherIds)
          : { data: [] }
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error
        const teacherMap: Record<string, { name: string; rate: number; currency: string }> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = { name: p.full_name ?? '', rate: Number(p.hourly_rate ?? 0), currency: p.currency ?? 'EUR' } })

        // Test teachers (profiles.is_test) never reach an export. The student side is
        // already excluded above, before studentIds was built.
        const testTeacherIds = new Set<string>()
        teacherRes.data?.forEach((p: any) => { if (p.is_test) testTeacherIds.add(p.id) })

        // Per-lesson pay rate from lesson_rate_snapshots (adminClient — deny-all RLS).
        // teacherMap rate (live profiles.hourly_rate) is the fallback only (NEW268 D1).
        const rateMap = await fetchLessonRateMap(adminClient, (lessons ?? []).map((l: { id: string }) => l.id))

        const sMap: Record<string, any> = {}
        realStudents.forEach((s: any) => { sMap[s.id] = s })

        // A class taught by a test teacher is dropped even when its student is real.
        const realLessons = (lessons ?? []).filter((l: any) => !testTeacherIds.has(l.teacher_id))

        const billingRows = realLessons.map((l: any) => {
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

          // Refund outcome belongs on the Status cell so it reads like the old LearnCube
          // Past Classes export. Only TRUE cancellations carry it. Reschedule legs
          // (rescheduled_by set) move the hours to the new booking and refund nothing, so
          // they keep the plain "Rescheduled by ..." label. Display only - getBillability
          // above is untouched and does not read hours_refunded.
          const isRescheduleLeg = l.rescheduled_by === 'student' || l.rescheduled_by === 'admin'
          if (cancelLabel !== null && !isRescheduleLeg) {
            statusLabel = `${statusLabel} - ${l.hours_refunded ? 'refunded' : 'not refunded'}`
          }

          const report = reportMap[l.id]

          // Earliest join click per user_type. Logic DUPLICATED from the
          // all-classes branch above (which in turn duplicates the local closure in
          // api/admin/reports/export/route.ts) — it is not exported from
          // anywhere, and the duplication is deliberate so the sheets stay
          // independently readable.
          const clicks = joinClickMap[l.id] ?? []
          const earliest = (userType: string): string | null => {
            const times = clicks
              .filter((c) => c.user_type === userType)
              .map((c) => c.clicked_at as string)
              .filter(Boolean)
            if (!times.length) return null
            return times.reduce((min: string, t: string) =>
              new Date(t).getTime() < new Date(min).getTime() ? t : min
            )
          }
          const teacherJoinedAt = earliest('teacher')
          const studentJoinedAt = earliest('student')

          // Cancellation window: absolute-instant gap between schedule and
          // cancellation, so it is timezone-independent. Boundaries copied verbatim
          // from the all-classes branch and api/admin/reports/export/route.ts:206 so
          // an identical lesson classifies identically on all three sheets. DISPLAY
          // ONLY — no money column is derived from it and getBillability
          // above is untouched.
          let cancellationWindow = ''
          if (l.cancelled_at) {
            const windowHours = (new Date(l.scheduled_at).getTime() - new Date(l.cancelled_at).getTime()) / 3600000
            if (windowHours < 24) cancellationWindow = '<24hr'
            else if (windowHours < 48) cancellationWindow = '24-48hr'
            else cancellationWindow = '>48hr'
          }

          return {
            'Company': student?.company_id ? cMap[student.company_id] ?? '' : '',
            'Student': student?.full_name ?? '',
            'Teacher': teacherMap[l.teacher_id]?.name ?? '',
            [dateHeader]: formatDateInTz(l.scheduled_at, exportTz),
            [timeHeader]: formatInstantInTz(l.scheduled_at, exportTz).slice(11),
            'Duration (min)': l.duration_minutes,
            'Status': statusLabel,
            'Billable (standard)': billable24 ? 'Yes' : 'No',
            'Billable cancellation (48hr policy)': billable48 ? 'Yes' : 'No',
            'Amount': bill.companyAmount,
            'Currency': teacherMap[l.teacher_id]?.currency ?? 'EUR',
            // Historical per-lesson snapshot rate (live profiles.hourly_rate is the
            // fallback only) — the live rate would retro-restate closed months.
            'Hourly Rate': resolveLessonRate(rateMap, l.id, teacherMap[l.teacher_id]?.rate ?? 0),
            // Teacher pay. Deliberately NOT 'Amount' above, which is bill.companyAmount.
            'Amount Owed to Teacher': bill.amount,
            'Class ID': l.id,
            'Booked At': fmtInstant(l.created_at),
            'Cancelled At': fmtInstant(l.cancelled_at),
            // RAW recorded value (live values are role words such as 'student'),
            // deliberately NOT passed through getCancellationLabel, not title-cased
            // and not derived from status — this column has to prove what
            // was stored. The 'Status' column above keeps the prose label; both are
            // intended, side by side.
            'Cancelled By': l.cancelled_by ?? '',
            'Hours Refunded': l.hours_refunded ? 'Yes' : 'No',
            'Cancellation Window': cancellationWindow,
            'Cancellation Reason': l.cancellation_reason ?? '',
            'Rescheduled At': fmtInstant(l.rescheduled_at),
            'Teacher Joined At': fmtInstant(teacherJoinedAt),
            'Student Joined At': fmtInstant(studentJoinedAt),
            'Teams Link Created': typeof l.teams_join_url === 'string' && l.teams_join_url.length > 0 ? 'Yes' : 'No',
            'Report Deadline': fmtInstant(report?.deadline_at),
            'Report Submitted At': fmtInstant(report?.completed_at),
            'Report Flagged At': fmtInstant(report?.flagged_at),
          }
        })

        rows = billingRows

        if (billingRows.length > 0) {
          // Currency guard: money may only be summed within ONE currency.
          const currencies = [...new Set(billingRows.map((r: any) => r['Currency'] as string))]
          const amountSum = billingRows.reduce((sum: number, r: any) => sum + Number(r['Amount'] ?? 0), 0)
          // Teacher pay is denominated in the same teacher currency as Amount, so the
          // single `currencies` guard above governs both sums. No second guard.
          const teacherPaySum = billingRows.reduce((sum: number, r: any) => sum + Number(r['Amount Owed to Teacher'] ?? 0), 0)
          totals = {
            'Company': 'TOTAL',
            'Amount': currencies.length === 1 ? Number(amountSum.toFixed(2)) : 'Mixed currencies - see rows',
            ...(currencies.length === 1 ? { 'Currency': currencies[0] } : {}),
            'Amount Owed to Teacher': currencies.length === 1 ? Number(teacherPaySum.toFixed(2)) : 'Mixed currencies - see rows',
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
            ? supabase.from('profiles').select('id, full_name, is_test').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in lessonRes && lessonRes.error) throw lessonRes.error
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        // Test accounts (profiles.is_test / students.is_test) never reach an export.
        const testTeacherIds = new Set<string>()
        teacherRes.data?.forEach((p: any) => { if (p.is_test) testTeacherIds.add(p.id) })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))]
        const filteredSIds = studentId ? [studentId] : sIds as string[]

        const studentRes2 = filteredSIds.length > 0
          ? await supabase.from('students').select('id, full_name, is_test').in('id', filteredSIds)
          : { data: [] }
        if ('error' in studentRes2 && studentRes2.error) throw studentRes2.error
        const studentMap: Record<string, string> = {}
        studentRes2.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        const testStudentIds = new Set<string>()
        studentRes2.data?.forEach((s: any) => { if (s.is_test) testStudentIds.add(s.id) })

        rows = []

        for (const report of reports ?? []) {
          const lesson = lessonMap[report.lesson_id]
          if (!lesson) continue
          // Dropped when EITHER side of the class is a test account.
          if (testTeacherIds.has(report.teacher_id)) continue
          if (testStudentIds.has(lesson.studentId)) continue
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
          { header: 'Hours Since Class', key: 'Hours Since Class', width: 18, format: 'decimal1' },
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
            ? supabase.from('profiles').select('id, full_name, is_test').in('id', tIds)
            : { data: [] },
        ])
        if ('error' in lessonRes && lessonRes.error) throw lessonRes.error
        if ('error' in teacherRes && teacherRes.error) throw teacherRes.error

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        // Test accounts (profiles.is_test / students.is_test) never reach an export.
        const testTeacherIds = new Set<string>()
        teacherRes.data?.forEach((p: any) => { if (p.is_test) testTeacherIds.add(p.id) })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))] as string[]
        const studentRes = sIds.length > 0
          ? await supabase.from('students').select('id, full_name, is_test').in('id', sIds)
          : { data: [] }
        if ('error' in studentRes && studentRes.error) throw studentRes.error
        const studentMap: Record<string, string> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        const testStudentIds = new Set<string>()
        studentRes.data?.forEach((s: any) => { if (s.is_test) testStudentIds.add(s.id) })

        const now = Date.now()

        // A report whose lesson row is missing still lists (as before) unless its own
        // teacher is a test account — the student side cannot be resolved without it.
        const visibleReports = (reports ?? []).filter((r: any) => {
          if (testTeacherIds.has(r.teacher_id)) return false
          const lesson = lessonMap[r.lesson_id]
          return !(lesson && testStudentIds.has(lesson.studentId))
        })

        rows = visibleReports.map((r: any) => {
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
