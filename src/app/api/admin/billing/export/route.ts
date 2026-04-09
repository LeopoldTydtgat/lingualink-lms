import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// A lesson is billable to the teacher when:
//   - status = 'completed'
//   - status = 'student_no_show'
//   - status = 'cancelled' AND cancelled_at is within 24hr of scheduled_at
// A lesson is a 48hr B2B flag when:
//   - status = 'cancelled'
//   - cancelled_at is between 24hr and 48hr before scheduled_at
//   - student.cancellation_policy = '48hr'
function billabilityFlags(
  status: string,
  scheduledAt: string,
  cancelledAt: string | null,
  cancellationPolicy: string | null
): { billableToTeacher: boolean; billable48hr: boolean } {
  if (status === 'completed' || status === 'student_no_show') {
    return { billableToTeacher: true, billable48hr: false }
  }

  if (status === 'cancelled' && cancelledAt) {
    const classTime = new Date(scheduledAt).getTime()
    const cancelTime = new Date(cancelledAt).getTime()
    const hoursNotice = (classTime - cancelTime) / (1000 * 60 * 60)

    if (hoursNotice < 24) return { billableToTeacher: true, billable48hr: false }

    if (hoursNotice >= 24 && hoursNotice < 48 && cancellationPolicy === '48hr') {
      return { billableToTeacher: false, billable48hr: true }
    }
  }

  return { billableToTeacher: false, billable48hr: false }
}

function lessonAmount(durationMinutes: number, hourlyRate: number): number {
  return Math.round((durationMinutes / 60) * hourlyRate * 100) / 100
}

// â”€â”€ Route â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ 1. Teacher Invoice Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (type === 'teacher_invoices') {
    let query = supabase
      .from('invoices')
      .select('id, billing_month, amount_eur, status, file_path, uploaded_at, paid_at, reference_number, teacher_id, profiles!invoices_teacher_id_fkey(full_name, email)')
      .order('billing_month', { ascending: false })

    if (teacherId) query = query.eq('teacher_id', teacherId)
    if (month) query = query.eq('billing_month', month)

    const { data: invoices } = await query

    const headers = ['Reference', 'Teacher', 'Email', 'Month', 'Amount (â‚¬)', 'Status', 'Uploaded At', 'Paid At']
    const rows = (invoices || []).map(inv => {
      const teacher = Array.isArray(inv.profiles) ? inv.profiles[0] : inv.profiles
      return [
        inv.reference_number,
        teacher?.full_name,
        teacher?.email,
        formatMonthCSV(inv.billing_month),
        inv.amount_eur != null ? Number(inv.amount_eur).toFixed(2) : '0.00',
        inv.status,
        inv.uploaded_at ? formatDateTimeCSV(inv.uploaded_at) : '',
        inv.paid_at ? formatDateTimeCSV(inv.paid_at) : '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'teacher-invoices.csv'
  }

  // â”€â”€ 2. Teacher Earnings Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  else if (type === 'teacher_earnings') {
    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name, email, hourly_rate')
      .in('role', ['teacher', 'admin'])
      .order('full_name')

    let lessonsQuery = supabase
      .from('lessons')
      .select('id, teacher_id, scheduled_at, duration_minutes, status, cancelled_at')
      .in('status', ['completed', 'student_no_show', 'cancelled'])

    if (teacherId) lessonsQuery = lessonsQuery.eq('teacher_id', teacherId)
    if (dateFrom) lessonsQuery = lessonsQuery.gte('scheduled_at', dateFrom)
    if (dateTo) lessonsQuery = lessonsQuery.lte('scheduled_at', dateTo)

    const { data: lessons } = await lessonsQuery

    // Group lessons by teacher Ã— month
    const earningsMap: Record<string, {
      teacherName: string
      teacherEmail: string
      month: string
      completed: number
      noShows: number
      totalHours: number
      hourlyRate: number
      totalOwed: number
    }> = {}

    for (const lesson of (lessons || [])) {
      const teacher = (teachers || []).find(t => t.id === lesson.teacher_id)
      if (!teacher) continue

      const { billableToTeacher } = billabilityFlags(lesson.status, lesson.scheduled_at, lesson.cancelled_at, null)
      if (!billableToTeacher) continue

      const d = new Date(lesson.scheduled_at)
      const monthKey = `${teacher.id}_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`

      if (!earningsMap[monthKey]) {
        earningsMap[monthKey] = {
          teacherName: teacher.full_name,
          teacherEmail: teacher.email,
          month: monthLabel,
          completed: 0,
          noShows: 0,
          totalHours: 0,
          hourlyRate: teacher.hourly_rate || 0,
          totalOwed: 0,
        }
      }

      const entry = earningsMap[monthKey]
      if (lesson.status === 'completed') entry.completed++
      if (lesson.status === 'student_no_show') entry.noShows++
      entry.totalHours += lesson.duration_minutes / 60
      entry.totalOwed += lessonAmount(lesson.duration_minutes, teacher.hourly_rate || 0)
    }

    const headers = ['Teacher', 'Email', 'Month', 'Classes Taken', 'Student No-Shows', 'Total Hours', 'Hourly Rate (â‚¬)', 'Total Owed (â‚¬)']
    const rows = Object.values(earningsMap).map(e => [
      e.teacherName,
      e.teacherEmail,
      formatMonthCSV(e.month),
      e.completed,
      e.noShows,
      e.totalHours.toFixed(2),
      e.hourlyRate.toFixed(2),
      e.totalOwed.toFixed(2),
    ])

    csv = toCSV(headers, rows)
    filename = 'teacher-earnings.csv'
  }

  // â”€â”€ 3. Student Hours Usage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  else if (type === 'student_hours') {
    let studentsQuery = supabase
      .from('students')
      .select('id, full_name, email, company_id, companies(name)')
      .order('full_name')

    if (studentId) studentsQuery = studentsQuery.eq('id', studentId)
    if (companyId) studentsQuery = studentsQuery.eq('company_id', companyId)

    const { data: students } = await studentsQuery

    const { data: trainings } = await supabase
      .from('trainings')
      .select('student_id, total_hours, hours_consumed, end_date, package_name')

    const headers = ['Student', 'Email', 'Company', 'Package', 'Total Hours', 'Hours Used', 'Hours Remaining', 'Training End Date']
    const rows = (students || []).map(s => {
      const training = (trainings || []).find(t => t.student_id === s.id)
      const company = Array.isArray(s.companies) ? s.companies[0] : s.companies
      const remaining = training ? (training.total_hours - training.hours_consumed) : 0
      return [
        s.full_name,
        s.email,
        company?.name || '',
        training?.package_name || '',
        training?.total_hours ?? 0,
        training?.hours_consumed ?? 0,
        remaining.toFixed(2),
        training?.end_date || '',
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'student-hours.csv'
  }

  // â”€â”€ 4. Company Billing Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  else if (type === 'company_billing') {
    let companiesQuery = supabase
      .from('companies')
      .select('id, name')
      .order('name')

    if (companyId) companiesQuery = companiesQuery.eq('id', companyId)

    const { data: companies } = await companiesQuery

    const { data: companyStudents } = await supabase
      .from('students')
      .select('id, full_name, company_id, cancellation_policy')
      .not('company_id', 'is', null)

    const studentIds = (companyStudents || []).map(s => s.id)

    let lessonsQuery = supabase
      .from('lessons')
      .select('id, student_id, teacher_id, scheduled_at, duration_minutes, status, cancelled_at, profiles!lessons_teacher_id_fkey(full_name)')
      .in('student_id', studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000'])

    if (dateFrom) lessonsQuery = lessonsQuery.gte('scheduled_at', dateFrom)
    if (dateTo) lessonsQuery = lessonsQuery.lte('scheduled_at', dateTo)

    const { data: lessons } = await lessonsQuery

    const headers = ['Company', 'Student', 'Teacher', 'Date & Time', 'Duration (min)', 'Status', 'Billable (24hr)', 'Billable (48hr policy)', 'Amount (â‚¬)']
    const rows: (string | number | boolean | null)[][] = []

    for (const company of (companies || [])) {
      const cStudents = (companyStudents || []).filter(s => s.company_id === company.id)

      for (const student of cStudents) {
        const sLessons = (lessons || []).filter(l => l.student_id === student.id)

        for (const lesson of sLessons) {
          const { billableToTeacher, billable48hr } = billabilityFlags(
            lesson.status,
            lesson.scheduled_at,
            lesson.cancelled_at,
            student.cancellation_policy
          )

          // Skip lessons that are neither billable in any way
          if (!billableToTeacher && !billable48hr) continue

          const teacher = Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles

          rows.push([
            company.name,
            student.full_name,
            teacher?.full_name || '',
            formatDateTimeCSV(lesson.scheduled_at),
            lesson.duration_minutes,
            lesson.status,
            billableToTeacher ? 'Yes' : 'No',
            billable48hr ? 'Yes' : 'No',
          ])
        }
      }
    }

    csv = toCSV(headers, rows)
    filename = 'company-billing.csv'
  }

  // â”€â”€ 5. Student Progress Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  else if (type === 'student_progress') {
    let reportsQuery = supabase
      .from('reports')
      .select('id, lesson_id, level_data, created_at, lessons(scheduled_at, teacher_id, student_id, profiles!lessons_teacher_id_fkey(full_name)), students(full_name)')
      .order('created_at', { ascending: false })

    if (studentId) reportsQuery = reportsQuery.eq('student_id', studentId)
    if (dateFrom) reportsQuery = reportsQuery.gte('created_at', dateFrom)
    if (dateTo) reportsQuery = reportsQuery.lte('created_at', dateTo)

    const { data: reports } = await reportsQuery

    const headers = ['Student', 'Class Date', 'Teacher', 'Grammar', 'Expression', 'Comprehension', 'Vocabulary', 'Accent', 'Spoken Level', 'Written Level']
    const rows = (reports || []).map(r => {
      const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons
      // Use unknown as intermediate to safely bridge the arrayâ†’object cast for nested profiles
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

  // â”€â”€ 6. Pending Reports Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  else if (type === 'pending_reports') {
    let query = supabase
      .from('lessons')
      .select('id, scheduled_at, duration_minutes, status, teacher_id, student_id, profiles!lessons_teacher_id_fkey(full_name), students(full_name)')
      .in('status', ['pending_report', 'flagged'])
      .order('scheduled_at', { ascending: false })

    if (teacherId) query = query.eq('teacher_id', teacherId)
    if (dateFrom) query = query.gte('scheduled_at', dateFrom)
    if (dateTo) query = query.lte('scheduled_at', dateTo)

    const { data: lessons } = await query

    const now = Date.now()
    const headers = ['Teacher', 'Student', 'Class Date & Time', 'Duration (min)', 'Status', 'Hours Since Class']
    const rows = (lessons || []).map(l => {
      const teacher = Array.isArray(l.profiles) ? l.profiles[0] : l.profiles
      const student = Array.isArray(l.students) ? l.students[0] : l.students
      const classEnd = new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000
      const hoursSince = Math.max(0, Math.floor((now - classEnd) / (1000 * 60 * 60)))
      return [
        (teacher as { full_name: string } | null)?.full_name || '',
        (student as { full_name: string } | null)?.full_name || '',
        formatDateTimeCSV(l.scheduled_at),
        l.duration_minutes,
        l.status,
        hoursSince,
      ]
    })

    csv = toCSV(headers, rows)
    filename = 'pending-reports.csv'
  }

  else {
    return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
  }

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
