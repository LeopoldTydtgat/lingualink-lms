import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// ─── CSV helper ───────────────────────────────────────────────────────────────

function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [
    headers.map(escapeCSV).join(','),
    ...rows.map(row => headers.map(h => escapeCSV(row[h])).join(',')),
  ]
  return lines.join('\r\n')
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

// Determine if a lesson is billable to the teacher
// Paid: completed classes, student no-shows, student cancels <24hr
// Not paid: teacher no-show, cancellations >24hr, teacher cancels
function isTeacherBillable(
  lessonStatus: string,
  didClassHappen: boolean | null,
  noShowType: string | null,
  scheduledAt: string,
  cancelledAt: string | null
): boolean {
  if (lessonStatus === 'completed') return true
  if (lessonStatus === 'no_show' && noShowType === 'student_no_show') return true
  if (lessonStatus === 'cancelled' && cancelledAt) {
    const scheduled = new Date(scheduledAt).getTime()
    const cancelled = new Date(cancelledAt).getTime()
    const hoursNotice = (scheduled - cancelled) / (1000 * 60 * 60)
    // Student cancelled with less than 24hr notice → teacher still paid
    if (hoursNotice < 24) return true
  }
  return false
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

async function checkAdminAccess(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()
  const allowedRoles = ['school_admin', 'hr_admin']
  return profile?.account_types?.some((r: string) => allowedRoles.includes(r)) ?? false
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const supabase = await createClient()
  const { type } = await params

  const allowed = await checkAdminAccess(supabase)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const fromDate = searchParams.get('from')   // YYYY-MM-DD
  const toDate = searchParams.get('to')       // YYYY-MM-DD
  const teacherId = searchParams.get('teacher')
  const studentId = searchParams.get('student')
  const companyId = searchParams.get('company')

  // Convert date strings to UTC range boundaries
  const fromTs = fromDate ? `${fromDate}T00:00:00.000Z` : null
  const toTs   = toDate   ? `${toDate}T23:59:59.999Z`   : null

  let csvContent = ''
  let filename = 'export.csv'

  try {
    switch (type) {

      // ── 1. All Classes Report ──────────────────────────────────────────────
      case 'all-classes': {
        filename = `lingualink-all-classes-${Date.now()}.csv`

        let query = supabase
          .from('lessons')
          .select(`
            id, scheduled_at, duration_minutes, status,
            cancelled_at, cancellation_reason,
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

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const studentMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        const companyIds = [...new Set(Object.values(studentMap).map(s => s.companyId).filter(Boolean))] as string[]
        const companyRes = companyIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', companyIds)
          : { data: [] }
        const companyMap: Record<string, string> = {}
        companyRes.data?.forEach((c: any) => { companyMap[c.id] = c.name })

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        // Filter by company if requested
        const filtered = companyId
          ? (lessons ?? []).filter((l: any) => studentMap[l.student_id]?.companyId === companyId)
          : (lessons ?? [])

        const rows = filtered.map((l: any) => {
          const report = reportMap[l.id]
          const student = studentMap[l.student_id]
          const billable = isTeacherBillable(l.status, report?.did_class_happen, report?.no_show_type, l.scheduled_at, l.cancelled_at)
          return {
            'Date': formatDate(l.scheduled_at),
            'Time (UTC)': formatDateTime(l.scheduled_at).slice(11),
            'Teacher': teacherMap[l.teacher_id] ?? '',
            'Student': student?.name ?? '',
            'Company': student?.companyId ? companyMap[student.companyId] ?? '' : 'Private',
            'Duration (min)': l.duration_minutes,
            'Status': l.status,
            'Report Status': report?.status ?? 'no report',
            'Billable to Teacher': billable ? 'Yes' : 'No',
            'Cancellation Reason': l.cancellation_reason ?? '',
          }
        })

        csvContent = toCSV(rows)
        break
      }

      // ── 2. Teacher Earnings Summary ────────────────────────────────────────
      case 'teacher-earnings': {
        filename = `lingualink-teacher-earnings-${Date.now()}.csv`

        let lessonsQuery = supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, teacher_id')
          .neq('status', 'upcoming') // only settled lessons
          .order('scheduled_at', { ascending: false })

        if (fromTs) lessonsQuery = lessonsQuery.gte('scheduled_at', fromTs)
        if (toTs)   lessonsQuery = lessonsQuery.lte('scheduled_at', toTs)
        if (teacherId) lessonsQuery = lessonsQuery.eq('teacher_id', teacherId)

        const { data: lessons, error: lErr } = await lessonsQuery
        if (lErr) throw lErr

        const lessonIds = (lessons ?? []).map((l: any) => l.id)
        const tIds = [...new Set((lessons ?? []).map((l: any) => l.teacher_id).filter(Boolean))]

        const [reportRes, profileRes] = await Promise.all([
          lessonIds.length > 0
            ? supabase.from('reports').select('lesson_id, did_class_happen, no_show_type').in('lesson_id', lessonIds)
            : { data: [] },
          tIds.length > 0
            ? supabase.from('profiles').select('id, full_name, hourly_rate').in('id', tIds)
            : { data: [] },
        ])

        const reportMap: Record<string, any> = {}
        reportRes.data?.forEach((r: any) => { reportMap[r.lesson_id] = r })

        const profileMap: Record<string, { name: string; rate: number }> = {}
        profileRes.data?.forEach((p: any) => { profileMap[p.id] = { name: p.full_name, rate: Number(p.hourly_rate ?? 0) } })

        // Group by teacher × month
        type EarningKey = string
        const summary: Record<EarningKey, {
          teacher: string
          month: string
          classesTaken: number
          studentNoShows: number
          totalMinutes: number
          rate: number
          billableAmount: number
          invoiceUploaded: string
        }> = {}

        for (const lesson of lessons ?? []) {
          const report = reportMap[lesson.id]
          const billable = isTeacherBillable(lesson.status, report?.did_class_happen, report?.no_show_type, lesson.scheduled_at, lesson.cancelled_at)
          if (!billable) continue

          const d = new Date(lesson.scheduled_at)
          const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
          const key = `${lesson.teacher_id}__${month}`
          const profile = profileMap[lesson.teacher_id]

          if (!summary[key]) {
            summary[key] = {
              teacher: profile?.name ?? '',
              month,
              classesTaken: 0,
              studentNoShows: 0,
              totalMinutes: 0,
              rate: profile?.rate ?? 0,
              billableAmount: 0,
              invoiceUploaded: '',
            }
          }

          summary[key].classesTaken++
          if (report?.no_show_type === 'student_no_show') summary[key].studentNoShows++
          summary[key].totalMinutes += lesson.duration_minutes ?? 0
          summary[key].billableAmount += ((lesson.duration_minutes ?? 0) / 60) * (profile?.rate ?? 0)
        }

        // Fetch invoice upload status per teacher/month
        const invoiceRes = await supabase.from('invoices').select('teacher_id, month, status')
        const invoiceMap: Record<string, string> = {}
        invoiceRes.data?.forEach((inv: any) => { invoiceMap[`${inv.teacher_id}__${inv.month}`] = inv.status })

        const rows = Object.entries(summary).map(([key, s]) => ({
          'Teacher': s.teacher,
          'Month': s.month,
          'Classes Taken': s.classesTaken,
          'Student No-Shows': s.studentNoShows,
          'Total Hours': (s.totalMinutes / 60).toFixed(2),
          'Hourly Rate (€)': s.rate.toFixed(2),
          'Total Owed (€)': s.billableAmount.toFixed(2),
          'Invoice Status': invoiceMap[key] ?? 'not uploaded',
        }))

        rows.sort((a, b) => a['Teacher'].localeCompare(b['Teacher']) || a['Month'].localeCompare(b['Month']))
        csvContent = toCSV(rows)
        break
      }

      // ── 3. Student Hours Usage ─────────────────────────────────────────────
      case 'student-hours': {
        filename = `lingualink-student-hours-${Date.now()}.csv`

        let trainQuery = supabase
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

        const sMap: Record<string, { name: string; companyId: string | null }> = {}
        studentRes.data?.forEach((s: any) => { sMap[s.id] = { name: s.full_name, companyId: s.company_id } })

        const cIds = [...new Set(Object.values(sMap).map(s => s.companyId).filter(Boolean))] as string[]
        const cRes = cIds.length > 0
          ? await supabase.from('companies').select('id, name').in('id', cIds)
          : { data: [] }
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        const filtered = companyId
          ? (trainings ?? []).filter((t: any) => sMap[t.student_id]?.companyId === companyId)
          : (trainings ?? [])

        const rows = filtered.map((t: any) => {
          const student = sMap[t.student_id]
          const remaining = Number(t.total_hours) - Number(t.hours_consumed)
          return {
            'Student': student?.name ?? '',
            'Company': student?.companyId ? cMap[student.companyId] ?? '' : 'Private',
            'Package': t.package_name ?? t.package_type ?? '',
            'Total Hours': Number(t.total_hours).toFixed(2),
            'Hours Used': Number(t.hours_consumed).toFixed(2),
            'Hours Remaining': remaining.toFixed(2),
            'Start Date': formatDate(t.start_date),
            'End Date': formatDate(t.end_date),
            'Status': t.status,
          }
        })

        csvContent = toCSV(rows)
        break
      }

      // ── 4. Company Billing Report ──────────────────────────────────────────
      case 'company-billing': {
        filename = `lingualink-company-billing-${Date.now()}.csv`

        // Get all B2B students (those with a company_id)
        let studentQuery = supabase
          .from('students')
          .select('id, full_name, company_id, cancellation_policy')
          .not('company_id', 'is', null)

        if (companyId) studentQuery = studentQuery.eq('company_id', companyId)
        const { data: students, error: sErr } = await studentQuery
        if (sErr) throw sErr

        const studentIds = (students ?? []).map((s: any) => s.id)
        if (studentIds.length === 0) { csvContent = toCSV([]); break }

        const cIds = [...new Set((students ?? []).map((s: any) => s.company_id).filter(Boolean))] as string[]
        const cRes = await supabase.from('companies').select('id, name').in('id', cIds)
        const cMap: Record<string, string> = {}
        cRes.data?.forEach((c: any) => { cMap[c.id] = c.name })

        let lessonsQuery = supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, student_id')
          .in('student_id', studentIds)
          .order('scheduled_at', { ascending: false })

        if (fromTs) lessonsQuery = lessonsQuery.gte('scheduled_at', fromTs)
        if (toTs)   lessonsQuery = lessonsQuery.lte('scheduled_at', toTs)

        const { data: lessons, error: lErr } = await lessonsQuery
        if (lErr) throw lErr

        const sMap: Record<string, any> = {}
        students?.forEach((s: any) => { sMap[s.id] = s })

        const rows = (lessons ?? []).map((l: any) => {
          const student = sMap[l.student_id]
          const policy = student?.cancellation_policy ?? '24hr'

          // Billable to company under 48hr policy
          let billable24 = false
          let billable48 = false

          if (l.status === 'completed') {
            billable24 = true
          } else if (l.status === 'cancelled' && l.cancelled_at) {
            const scheduled = new Date(l.scheduled_at).getTime()
            const cancelled = new Date(l.cancelled_at).getTime()
            const hours = (scheduled - cancelled) / (1000 * 60 * 60)
            if (hours < 24) billable24 = true
            else if (hours >= 24 && hours < 48 && policy === '48hr') billable48 = true
          } else if (l.status === 'no_show') {
            billable24 = true
          }

          return {
            'Company': student?.company_id ? cMap[student.company_id] ?? '' : '',
            'Student': student?.full_name ?? '',
            'Date': formatDate(l.scheduled_at),
            'Time (UTC)': formatDateTime(l.scheduled_at).slice(11),
            'Duration (min)': l.duration_minutes,
            'Status': l.status,
            'Billable (standard)': billable24 ? 'Yes' : 'No',
            'Billable cancellation (48hr policy)': billable48 ? 'Yes' : 'No',
          }
        })

        csvContent = toCSV(rows)
        break
      }

      // ── 5. Student Progress Report ─────────────────────────────────────────
      case 'student-progress': {
        filename = `lingualink-student-progress-${Date.now()}.csv`

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

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))]
        const filteredSIds = studentId ? [studentId] : sIds as string[]

        const studentRes2 = filteredSIds.length > 0
          ? await supabase.from('students').select('id, full_name').in('id', filteredSIds)
          : { data: [] }
        const studentMap: Record<string, string> = {}
        studentRes2.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        const rows: Record<string, unknown>[] = []

        for (const report of reports ?? []) {
          const lesson = lessonMap[report.lesson_id]
          if (!lesson) continue
          if (studentId && lesson.studentId !== studentId) continue

          const ld = report.level_data as Record<string, string> | null
          if (!ld) continue

          rows.push({
            'Student': studentMap[lesson.studentId] ?? '',
            'Class Date': formatDate(lesson.scheduledAt),
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

        csvContent = toCSV(rows)
        break
      }

      // ── 6. Pending Reports Log ─────────────────────────────────────────────
      case 'pending-reports': {
        filename = `lingualink-pending-reports-${Date.now()}.csv`

        let query = supabase
          .from('reports')
          .select('id, lesson_id, teacher_id, status, flagged_at, deadline_at, created_at')
          .in('status', ['pending', 'flagged'])
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

        const lessonMap: Record<string, { studentId: string; scheduledAt: string }> = {}
        lessonRes.data?.forEach((l: any) => { lessonMap[l.id] = { studentId: l.student_id, scheduledAt: l.scheduled_at } })

        const teacherMap: Record<string, string> = {}
        teacherRes.data?.forEach((p: any) => { teacherMap[p.id] = p.full_name })

        const sIds = [...new Set(Object.values(lessonMap).map(l => l.studentId).filter(Boolean))] as string[]
        const studentRes = sIds.length > 0
          ? await supabase.from('students').select('id, full_name').in('id', sIds)
          : { data: [] }
        const studentMap: Record<string, string> = {}
        studentRes.data?.forEach((s: any) => { studentMap[s.id] = s.full_name })

        const now = Date.now()

        const rows = (reports ?? []).map((r: any) => {
          const lesson = lessonMap[r.lesson_id]
          const classEndTime = lesson
            ? new Date(lesson.scheduledAt).getTime()
            : null
          const hoursSinceClass = classEndTime
            ? ((now - classEndTime) / (1000 * 60 * 60)).toFixed(1)
            : ''

          return {
            'Teacher': teacherMap[r.teacher_id] ?? '',
            'Student': lesson ? studentMap[lesson.studentId] ?? '' : '',
            'Class Date': lesson ? formatDateTime(lesson.scheduledAt) : '',
            'Hours Since Class': hoursSinceClass,
            'Report Status': r.status,
            'Deadline': r.deadline_at ? formatDateTime(r.deadline_at) : '',
            'Flagged At': r.flagged_at ? formatDateTime(r.flagged_at) : '',
          }
        })

        csvContent = toCSV(rows)
        break
      }

      default:
        return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
    }
  } catch (err: any) {
    console.error(`Export error [${type}]:`, err)
    return NextResponse.json({ error: err.message ?? 'Export failed' }, { status: 500 })
  }

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
