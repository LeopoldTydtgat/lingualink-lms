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

// ── Helpers ────────────────────────────────────────────────────────────────────────────

// Instant (timestamptz) columns render in the resolved export timezone via
// formatInstantInTz. billing_month below is a date-only value (YYYY-MM-01) and
// is NOT an instant, so it keeps its own month formatter.
function formatMonthCSV(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function toCSV(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const lines = [headers.map(escapeCSV).join(',')]
  for (const row of rows) {
    lines.push(row.map(escapeCSV).join(','))
  }
  return lines.join('\n')
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
  const type = searchParams.get('type') // 'teacher_invoices' | 'student_hours' | 'company_billing' | 'student_progress' | 'pending_reports'
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const teacherId = searchParams.get('teacherId')
  const studentId = searchParams.get('studentId')
  const companyId = searchParams.get('companyId')
  const month = searchParams.get('month') // YYYY-MM-01 for teacher_invoices

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

  let csv = ''
  let filename = 'export.csv'

  try {

  // ── 1. Teacher Invoice Summary ────────────────────────────────────────────────────────
  if (type === 'teacher_invoices') {
    // Refresh amount_eur before export so the CSV matches the admin Billing
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

    const { data: invoices, error: invoicesErr } = await query
    if (invoicesErr) throw invoicesErr

    const headers = ['Reference', 'Teacher', 'Email', 'Month', 'Amount', 'Currency', 'Status', `Uploaded At (${exportTzLabel})`, `Paid At (${exportTzLabel})`]
    const rows = (invoices || []).map(inv => {
      const teacher = Array.isArray(inv.profiles) ? inv.profiles[0] : inv.profiles
      return [
        inv.reference_number,
        teacher?.full_name,
        teacher?.email,
        formatMonthCSV(inv.billing_month),
        inv.amount_eur != null ? Number(inv.amount_eur).toFixed(2) : '0.00',
        (teacher as { full_name: string; email: string; currency?: string | null } | null)?.currency || 'EUR',
        inv.status,
        inv.uploaded_at ? formatInstantInTz(inv.uploaded_at, exportTz) : '',
        inv.paid_at ? formatInstantInTz(inv.paid_at, exportTz) : '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'teacher-invoices.csv'
  }

  // ── 4. Company Billing Report ─────────────────────────────────────────────────────────
  else if (type === 'company_billing') {
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

    const headers = ['Company', 'Student', 'Teacher', `Date & Time (${exportTzLabel})`, 'Duration (min)', 'Status', 'Billable (24hr)', 'Billable (48hr policy)', 'Amount', 'Currency']
    const rows: (string | number | boolean | null)[][] = []

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

          rows.push([
            company.name,
            student.full_name,
            teacher?.full_name || '',
            formatInstantInTz(lesson.scheduled_at, exportTz),
            lesson.duration_minutes,
            lesson.status,
            bill.billableToTeacher ? 'Yes' : 'No',
            bill.billable48hr ? 'Yes' : 'No',
            bill.companyAmount,
            teacher?.currency || 'EUR',
          ])
        }
      }
    }

    csv = toCSV(headers, rows)
    filename = 'company-billing.csv'
  }

  // ── 5. Student Progress Report ────────────────────────────────────────────────────────
  else if (type === 'student_progress') {
    let reportsQuery = supabase
      .from('reports')
      .select('id, lesson_id, level_data, created_at, lessons(scheduled_at, teacher_id, student_id, profiles!lessons_teacher_id_fkey(full_name)), students(full_name)')
      .order('created_at', { ascending: false })

    if (studentId) reportsQuery = reportsQuery.eq('student_id', studentId)
    if (dateGteIso) reportsQuery = reportsQuery.gte('created_at', dateGteIso)
    if (dateLtIso) reportsQuery = reportsQuery.lt('created_at', dateLtIso)

    const { data: reports, error: reportsErr } = await reportsQuery
    if (reportsErr) throw reportsErr

    const headers = ['Student', `Class Date (${exportTzLabel})`, 'Teacher', 'Grammar', 'Expression', 'Comprehension', 'Vocabulary', 'Accent', 'Spoken Level', 'Written Level']
    const rows = (reports || []).map(r => {
      const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons
      // Use unknown as intermediate to safely bridge the array→object cast for nested profiles
      const lessonWithProfiles = lesson as unknown as { scheduled_at: string; profiles: { full_name: string }[] } | null
      const teacher = lessonWithProfiles
        ? (Array.isArray(lessonWithProfiles.profiles) ? lessonWithProfiles.profiles[0] : null)
        : null
      const student = Array.isArray(r.students) ? r.students[0] : r.students
      const ld = (r.level_data as Record<string, string>) || {}
      return [
        (student as { full_name: string } | null)?.full_name || '',
        lessonWithProfiles?.scheduled_at ? formatInstantInTz(lessonWithProfiles.scheduled_at, exportTz) : '',
        teacher?.full_name || '',
        ld.grammar || '',
        ld.expression || '',
        ld.comprehension || '',
        ld.vocabulary || '',
        ld.accent || '',
        ld.spoken_level || '',
        ld.written_level || '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'student-progress.csv'
  }

  // ── 6. Pending Reports Log ────────────────────────────────────────────────────────────
  else if (type === 'pending_reports') {
    // Pending reports live in the `reports` table — `lessons` has no
    // 'pending_report' status. Query reports, then join lessons + names by id
    // (mirrors /api/admin/exports/[type] pending-reports).
    let query = supabase
      .from('reports')
      .select('id, lesson_id, teacher_id, status, created_at')
      .in('status', ['pending', 'flagged', 'reopened'])
      .order('created_at', { ascending: false })

    if (teacherId) query = query.eq('teacher_id', teacherId)
    if (dateGteIso) query = query.gte('created_at', dateGteIso)
    if (dateLtIso) query = query.lt('created_at', dateLtIso)

    const { data: reports, error: reportsErr } = await query
    if (reportsErr) throw reportsErr

    const lessonIds = (reports || []).map((r: any) => r.lesson_id).filter(Boolean)
    const tIds = [...new Set((reports || []).map((r: any) => r.teacher_id).filter(Boolean))]

    const [lessonRes, teacherRes] = await Promise.all([
      lessonIds.length > 0
        ? supabase.from('lessons').select('id, student_id, scheduled_at, duration_minutes').in('id', lessonIds)
        : { data: [] },
      tIds.length > 0
        ? supabase.from('profiles').select('id, full_name').in('id', tIds)
        : { data: [] },
    ])
    if ('error' in lessonRes && lessonRes.error) throw lessonRes.error
    if ('error' in teacherRes && teacherRes.error) throw teacherRes.error

    const lessonMap: Record<string, { studentId: string; scheduledAt: string; durationMinutes: number }> = {}
    lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at, durationMinutes: l.duration_minutes } })

    const teacherMap: Record<string, string> = {}
    teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

    const studentIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))] as string[]
    const studentRes = studentIds.length > 0
      ? await supabase.from('students').select('id, full_name').in('id', studentIds)
      : { data: [] }
    if ('error' in studentRes && studentRes.error) throw studentRes.error
    const studentMap: Record<string, string> = {}
    studentRes.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

    const now = Date.now()
    const headers = ['Teacher', 'Student', `Class Date & Time (${exportTzLabel})`, 'Duration (min)', 'Status', 'Hours Since Class']
    const rows = (reports || []).map((r: any) => {
      const lesson = lessonMap[r.lesson_id]
      return [
        teacherMap[r.teacher_id] ?? '',
        lesson ? (studentMap[lesson.studentId] ?? '') : '',
        lesson ? formatInstantInTz(lesson.scheduledAt, exportTz) : '',
        lesson ? lesson.durationMinutes : '',
        r.status,
        lesson ? Math.max(0, Math.floor((now - (new Date(lesson.scheduledAt).getTime() + lesson.durationMinutes * 60 * 1000)) / (1000 * 60 * 60))) : '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'pending-reports.csv'
  }

  else {
    return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
  }

  } catch (err: any) {
    console.error(`Export error [${type}]:`, err)
    Sentry.captureException(err)
    return NextResponse.json({ error: err.message ?? 'Export failed' }, { status: 500 })
  }

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
