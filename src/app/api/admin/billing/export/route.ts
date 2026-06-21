import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { getBillability, MONTH_BILLING_PREFILTER_STATUSES } from '@/lib/billing/billability'
import { getMonthKeyInTz } from '@/lib/billing/monthRange'
import {
  recomputeInvoiceAmountsForTeacher,
  recomputeInvoiceAmountsForAllTeachers,
} from '@/lib/billing/recomputeAmounts'

// ── Helpers ────────────────────────────────────────────────────────────────────────────

function formatDateTimeCSV(dateStr: string): string {
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${mins}`
}

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

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') // 'teacher_invoices' | 'teacher_earnings' | 'student_hours' | 'company_billing' | 'student_progress' | 'pending_reports'
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const teacherId = searchParams.get('teacherId')
  const studentId = searchParams.get('studentId')
  const companyId = searchParams.get('companyId')
  const month = searchParams.get('month') // YYYY-MM-01 for teacher_invoices

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

    let query = supabase
      .from('invoices')
      .select('id, billing_month, amount_eur, status, file_path, uploaded_at, paid_at, reference_number, teacher_id, profiles!invoices_teacher_id_fkey(full_name, email, currency)')
      .order('billing_month', { ascending: false })

    if (teacherId) query = query.eq('teacher_id', teacherId)
    if (month) query = query.eq('billing_month', month)

    const { data: invoices, error: invoicesErr } = await query
    if (invoicesErr) throw invoicesErr

    const headers = ['Reference', 'Teacher', 'Email', 'Month', 'Amount', 'Currency', 'Status', 'Uploaded At', 'Paid At']
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
        inv.uploaded_at ? formatDateTimeCSV(inv.uploaded_at) : '',
        inv.paid_at ? formatDateTimeCSV(inv.paid_at) : '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'teacher-invoices.csv'
  }

  // ── 2. Teacher Earnings Summary ───────────────────────────────────────────────────────
  else if (type === 'teacher_earnings') {
    // hourly_rate has a column-level REVOKE on `authenticated` — must use the
    // admin client. Role check above has already gated access to this branch.
    const adminClient = createAdminClient()
    const { data: teachers, error: teachersErr } = await adminClient
      .from('profiles')
      .select('id, full_name, email, hourly_rate, timezone, currency')
      .in('role', ['teacher', 'admin'])
      .order('full_name')
    if (teachersErr) throw teachersErr

    let lessonsQuery = supabase
      .from('lessons')
      .select('id, teacher_id, scheduled_at, duration_minutes, status, cancelled_at')
      .in('status', MONTH_BILLING_PREFILTER_STATUSES)

    if (teacherId) lessonsQuery = lessonsQuery.eq('teacher_id', teacherId)
    if (dateFrom) lessonsQuery = lessonsQuery.gte('scheduled_at', dateFrom)
    if (dateTo) lessonsQuery = lessonsQuery.lte('scheduled_at', dateTo)

    const { data: lessons, error: lessonsErr } = await lessonsQuery
    if (lessonsErr) throw lessonsErr

    // Group lessons by teacher × month (in the teacher's local timezone)
    const earningsMap: Record<string, {
      teacherName: string
      teacherEmail: string
      month: string
      completed: number
      noShows: number
      totalHours: number
      hourlyRate: number
      currency: string
      totalOwed: number
    }> = {}

    const missingTzTeachers = new Set<string>()

    for (const lesson of (lessons || [])) {
      const teacher = (teachers || []).find(t => t.id === lesson.teacher_id)
      if (!teacher) continue

      const bill = getBillability({
        status: lesson.status,
        scheduledAt: lesson.scheduled_at,
        cancelledAt: lesson.cancelled_at,
        cancellationPolicy: null,
        hourlyRate: teacher.hourly_rate || 0,
        durationMinutes: lesson.duration_minutes,
      })
      if (!bill.billableToTeacher) continue

      if (!teacher.timezone) {
        missingTzTeachers.add(teacher.id)
        continue
      }
      const monthKey = getMonthKeyInTz(new Date(lesson.scheduled_at), teacher.timezone)
      const mapKey = `${teacher.id}_${monthKey}`

      if (!earningsMap[mapKey]) {
        earningsMap[mapKey] = {
          teacherName: teacher.full_name,
          teacherEmail: teacher.email,
          month: monthKey,
          completed: 0,
          noShows: 0,
          totalHours: 0,
          hourlyRate: teacher.hourly_rate || 0,
          currency: teacher.currency || 'EUR',
          totalOwed: 0,
        }
      }

      const entry = earningsMap[mapKey]
      if (lesson.status === 'completed') entry.completed++
      if (lesson.status === 'student_no_show') entry.noShows++
      entry.totalHours += lesson.duration_minutes / 60
      entry.totalOwed += bill.amount
    }

    if (missingTzTeachers.size > 0) {
      return NextResponse.json(
        { error: 'TIMEZONE_MISSING', message: `Cannot export earnings: ${missingTzTeachers.size} teacher(s) have no timezone set. Set their timezones before exporting.` },
        { status: 422 }
      )
    }

    const headers = ['Teacher', 'Email', 'Month', 'Classes Taken', 'Student No-Shows', 'Total Hours', 'Hourly Rate', 'Total Owed', 'Currency']
    const rows = Object.values(earningsMap).map(e => [
      e.teacherName,
      e.teacherEmail,
      formatMonthCSV(e.month),
      e.completed,
      e.noShows,
      e.totalHours.toFixed(2),
      e.hourlyRate.toFixed(2),
      e.totalOwed.toFixed(2),
      e.currency,
    ])

    csv = toCSV(headers, rows)
    filename = 'teacher-earnings.csv'
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
      .select('id, student_id, teacher_id, scheduled_at, duration_minutes, status, cancelled_at, profiles!lessons_teacher_id_fkey(full_name, hourly_rate, currency)')
      .in('student_id', studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000'])

    if (dateFrom) lessonsQuery = lessonsQuery.gte('scheduled_at', dateFrom)
    if (dateTo) lessonsQuery = lessonsQuery.lte('scheduled_at', dateTo)

    const { data: lessons, error: lessonsErr } = await lessonsQuery
    if (lessonsErr) throw lessonsErr

    const headers = ['Company', 'Student', 'Teacher', 'Date & Time', 'Duration (min)', 'Status', 'Billable (24hr)', 'Billable (48hr policy)', 'Amount', 'Currency']
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
            hourlyRate: teacher?.hourly_rate ?? 0,
            durationMinutes: lesson.duration_minutes,
          })

          // Skip lessons that are neither billable in any way
          if (!bill.billableToTeacher && !bill.billable48hr) continue

          rows.push([
            company.name,
            student.full_name,
            teacher?.full_name || '',
            formatDateTimeCSV(lesson.scheduled_at),
            lesson.duration_minutes,
            lesson.status,
            bill.billableToTeacher ? 'Yes' : 'No',
            bill.billable48hr ? 'Yes' : 'No',
            bill.amount,
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
    if (dateFrom) reportsQuery = reportsQuery.gte('created_at', dateFrom)
    if (dateTo) reportsQuery = reportsQuery.lte('created_at', dateTo)

    const { data: reports, error: reportsErr } = await reportsQuery
    if (reportsErr) throw reportsErr

    const headers = ['Student', 'Class Date', 'Teacher', 'Grammar', 'Expression', 'Comprehension', 'Vocabulary', 'Accent', 'Spoken Level', 'Written Level']
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
        lessonWithProfiles?.scheduled_at ? formatDateTimeCSV(lessonWithProfiles.scheduled_at) : '',
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
    if (dateFrom) query = query.gte('created_at', dateFrom)
    if (dateTo) query = query.lte('created_at', dateTo)

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
    const headers = ['Teacher', 'Student', 'Class Date & Time', 'Duration (min)', 'Status', 'Hours Since Class']
    const rows = (reports || []).map((r: any) => {
      const lesson = lessonMap[r.lesson_id]
      return [
        teacherMap[r.teacher_id] ?? '',
        lesson ? (studentMap[lesson.studentId] ?? '') : '',
        lesson ? formatDateTimeCSV(lesson.scheduledAt) : '',
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
