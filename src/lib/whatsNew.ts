// src/lib/whatsNew.ts
//
// Derives the teacher-scoped "What's New" feed for the dashboard right panel.
// Every query here is scoped to the logged-in teacher (teacher_id / assigned
// training). Event sources look back 7 days; state sources (reopened/flagged
// reports, low hours, ending trainings, missing invoice) are current-state and
// are not windowed. Cap 6, attention items first, then newest first.
//
// Date rules (root CLAUDE.md): booked-class time is formatted in the teacher's
// account timezone via utcInstantToTzParts — never toISOString for local dates,
// never toLocaleTimeString. Date-only columns (end_date, billing_month) are
// split on their literal 'YYYY-MM-DD' string, never round-tripped through Date.

import type { createClient } from '@/lib/supabase/server'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'

type ServerClient = Awaited<ReturnType<typeof createClient>>

export type WhatsNewItem = {
  id: string
  kind: string
  text: string
  href: string
  at: string
  attention?: boolean
  // Synthetic-timestamp items (invoice reminder, low hours, ending training) set
  // this false so the UI never renders their nowIso `at` as a "just now" age.
  showTime?: boolean
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const pad = (n: number) => String(n).padStart(2, '0')

// "Wed 22 Jul, 08:00" in the teacher's account timezone. Falls back to UTC on a
// missing/invalid tz rather than throwing (this feeds a panel with no error
// boundary above it, same posture as RightPanel.formatClassTime).
function formatClassMoment(iso: string, tz: string | null): string {
  const zone = tz && isValidTimeZone(tz) ? tz : 'UTC'
  const p = utcInstantToTzParts(iso, zone)
  return `${WEEKDAYS[p.weekday]} ${pad(p.day)} ${MONTHS_SHORT[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)}`
}

// "Wed 15 Jul" in the teacher's account timezone (no time). Same fallback posture
// as formatClassMoment.
function formatClassDay(iso: string, tz: string | null): string {
  const zone = tz && isValidTimeZone(tz) ? tz : 'UTC'
  const p = utcInstantToTzParts(iso, zone)
  return `${WEEKDAYS[p.weekday]} ${pad(p.day)} ${MONTHS_SHORT[p.month - 1]}`
}

// "22 Jul 2026" from a literal date-only 'YYYY-MM-DD' string. No Date round-trip.
function formatDateOnly(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${d} ${MONTHS_SHORT[(m || 1) - 1]} ${y}`
}

// "July" from a date-only 'YYYY-MM-DD' string.
function monthLongName(dateStr: string): string {
  const m = Number(dateStr.split('-')[1])
  return MONTHS_LONG[(m || 1) - 1]
}

export async function fetchWhatsNew(
  supabase: ServerClient,
  teacherId: string,
): Promise<WhatsNewItem[]> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const sinceIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Teacher timezone — needed to format booked-class times and to derive the
  // current billing month for the invoice reminder. Explicit column (profiles
  // has column-level REVOKEs; never select '*').
  const { data: prof } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', teacherId)
    .maybeSingle()
  const tz: string | null = prof?.timezone ?? null
  const tzZone = tz && isValidTimeZone(tz) ? tz : 'UTC'

  // Current billing month key in the teacher's timezone (billing_month is stored
  // as the first-of-month date).
  const todayParts = utcInstantToTzParts(nowIso, tzZone)
  const currentMonthKey = `${todayParts.year}-${pad(todayParts.month)}-01`
  const dayOfMonth = todayParts.day

  // ── Source queries (teacher-scoped) ─────────────────────────────────────────
  const [
    ttRes,
    bookedRes,
    cancelledRes,
    rescheduledRes,
    reopenedRes,
    flaggedRes,
    paidRes,
    curMonthInvoiceRes,
  ] = await Promise.all([
    // All of this teacher's training assignments — assigned_at drives the "new
    // student" event; the training ids also drive the hours-low / ending checks.
    supabase
      .from('training_teachers')
      .select('training_id, assigned_at')
      .eq('teacher_id', teacherId),
    supabase
      .from('lessons')
      .select('id, student_id, scheduled_at, created_at, rescheduled_at')
      .eq('teacher_id', teacherId)
      .eq('status', 'scheduled')
      .gte('created_at', sinceIso),
    supabase
      .from('lessons')
      .select('id, student_id, scheduled_at, cancelled_at')
      .eq('teacher_id', teacherId)
      .eq('cancelled_by', 'student')
      .gte('cancelled_at', sinceIso),
    supabase
      .from('lessons')
      .select('id, student_id, rescheduled_at')
      .eq('teacher_id', teacherId)
      .eq('rescheduled_by', 'student')
      .gte('rescheduled_at', sinceIso),
    supabase
      .from('reports')
      .select('id, updated_at, lesson_id')
      .eq('teacher_id', teacherId)
      .eq('status', 'reopened')
      .gte('updated_at', sinceIso),
    supabase
      .from('reports')
      .select('id, flagged_at, updated_at, lesson_id')
      .eq('teacher_id', teacherId)
      .eq('status', 'flagged')
      .gte('flagged_at', sinceIso),
    supabase
      .from('invoices')
      .select('id, paid_at, billing_month')
      .eq('teacher_id', teacherId)
      .not('paid_at', 'is', null)
      .gte('paid_at', sinceIso),
    supabase
      .from('invoices')
      .select('id')
      .eq('teacher_id', teacherId)
      .eq('billing_month', currentMonthKey)
      .limit(1)
      .maybeSingle(),
  ])

  const ttRows = ttRes.data ?? []
  const trainingIds = [...new Set(ttRows.map((r) => r.training_id))]

  // Lessons referenced by the reopened/flagged reports — for the student name and
  // class day woven into those texts.
  const reportLessonIds = [...new Set(
    [...(reopenedRes.data ?? []), ...(flaggedRes.data ?? [])]
      .map((r) => r.lesson_id)
      .filter((id): id is string => !!id),
  )]

  // Both depend only on the first batch, so fetch together: trainings for this
  // teacher's assignments (student_id, hours, end_date) and the report lessons.
  const [trainingsRes, reportLessonsRes] = await Promise.all([
    trainingIds.length
      ? supabase
          .from('trainings')
          .select('id, student_id, total_hours, hours_consumed, end_date, status, updated_at')
          .in('id', trainingIds)
      : Promise.resolve({ data: [] as Array<{ id: string; student_id: string; total_hours: number; hours_consumed: number; end_date: string | null; status: string; updated_at: string | null }> }),
    reportLessonIds.length
      ? supabase
          .from('lessons')
          .select('id, student_id, scheduled_at')
          .in('id', reportLessonIds)
      : Promise.resolve({ data: [] as Array<{ id: string; student_id: string; scheduled_at: string }> }),
  ])

  const trainingRows = trainingsRes.data ?? []
  const trainingById = new Map(trainingRows.map((t) => [t.id, t]))
  const reportLessonById = new Map((reportLessonsRes.data ?? []).map((l) => [l.id, l]))

  // ── Collect every student id we need a name for, then batch one query ────────
  const studentIds = new Set<string>()
  for (const r of ttRows) {
    if (new Date(r.assigned_at).getTime() >= nowMs - 7 * 24 * 60 * 60 * 1000) {
      const t = trainingById.get(r.training_id)
      if (t) studentIds.add(t.student_id)
    }
  }
  for (const l of bookedRes.data ?? []) studentIds.add(l.student_id)
  for (const l of cancelledRes.data ?? []) studentIds.add(l.student_id)
  for (const l of rescheduledRes.data ?? []) studentIds.add(l.student_id)
  for (const l of reportLessonsRes.data ?? []) studentIds.add(l.student_id)
  for (const t of trainingRows ?? []) {
    if (t.status !== 'active') continue
    const remaining = Number(t.total_hours) - Number(t.hours_consumed)
    const endingSoon = t.end_date ? withinDays(t.end_date, 14, todayParts) : false
    if (remaining < 2 || endingSoon) studentIds.add(t.student_id)
  }

  const { data: studentRows } = studentIds.size
    ? await supabase.from('students').select('id, full_name').in('id', [...studentIds])
    : { data: [] as Array<{ id: string; full_name: string }> }
  const nameById = new Map((studentRows ?? []).map((s) => [s.id, s.full_name]))
  const nameOf = (id: string) => nameById.get(id) ?? 'A student'

  // ── Build items ─────────────────────────────────────────────────────────────
  const items: WhatsNewItem[] = []

  // New student assigned (event, windowed)
  for (const r of ttRows) {
    if (new Date(r.assigned_at).getTime() < nowMs - 7 * 24 * 60 * 60 * 1000) continue
    const t = trainingById.get(r.training_id)
    if (!t) continue
    items.push({
      id: `assigned-${r.training_id}`,
      kind: 'student_assigned',
      text: `New student assigned: ${nameOf(t.student_id)}`,
      href: '/students',
      at: r.assigned_at,
    })
  }

  // Class booked (event, windowed). Skip rows whose created_at sits within 60s of
  // their rescheduled_at — those are reschedule legs, surfaced separately.
  for (const l of bookedRes.data ?? []) {
    if (l.rescheduled_at) {
      const diff = Math.abs(new Date(l.created_at).getTime() - new Date(l.rescheduled_at).getTime())
      if (diff < 60_000) continue
    }
    items.push({
      id: `booked-${l.id}`,
      kind: 'class_booked',
      text: `${nameOf(l.student_id)} booked a class - ${formatClassMoment(l.scheduled_at, tz)}`,
      href: '/',
      at: l.created_at,
    })
  }

  // Cancelled by student (event, windowed)
  for (const l of cancelledRes.data ?? []) {
    if (!l.cancelled_at) continue
    const shortNotice =
      new Date(l.scheduled_at).getTime() - new Date(l.cancelled_at).getTime() < 24 * 60 * 60 * 1000
    items.push({
      id: `cancelled-${l.id}`,
      kind: 'class_cancelled',
      text: shortNotice
        ? `${nameOf(l.student_id)} cancelled within 24hr - you are paid for this class`
        : `${nameOf(l.student_id)} cancelled a class`,
      href: '/',
      at: l.cancelled_at,
    })
  }

  // Rescheduled by student (event, windowed)
  for (const l of rescheduledRes.data ?? []) {
    if (!l.rescheduled_at) continue
    items.push({
      id: `rescheduled-${l.id}`,
      kind: 'class_rescheduled',
      text: `${nameOf(l.student_id)} rescheduled a class`,
      href: '/',
      at: l.rescheduled_at,
    })
  }

  // Report reopened (event, windowed on updated_at)
  for (const r of reopenedRes.data ?? []) {
    const lesson = r.lesson_id ? reportLessonById.get(r.lesson_id) : undefined
    items.push({
      id: `report-reopened-${r.id}`,
      kind: 'report_reopened',
      text: lesson
        ? `Report reopened by admin: ${nameOf(lesson.student_id)}, ${formatClassDay(lesson.scheduled_at, tz)}`
        : 'A report was reopened by admin',
      href: '/reports',
      at: r.updated_at ?? nowIso,
      attention: true,
    })
  }

  // Report missed / flagged (event, windowed on flagged_at)
  for (const r of flaggedRes.data ?? []) {
    const lesson = r.lesson_id ? reportLessonById.get(r.lesson_id) : undefined
    items.push({
      id: `report-flagged-${r.id}`,
      kind: 'report_missed',
      text: lesson
        ? `Missed report: ${nameOf(lesson.student_id)}, ${formatClassDay(lesson.scheduled_at, tz)} - payment withheld`
        : 'Missed report - payment withheld until completed',
      href: '/reports',
      at: r.flagged_at ?? r.updated_at ?? nowIso,
      attention: true,
    })
  }

  // Invoice paid (event, windowed)
  for (const inv of paidRes.data ?? []) {
    if (!inv.paid_at) continue
    items.push({
      id: `invoice-paid-${inv.id}`,
      kind: 'invoice_paid',
      text: `Your ${inv.billing_month ? monthLongName(inv.billing_month) : 'latest'} invoice was marked paid`,
      href: '/billing',
      at: inv.paid_at,
    })
  }

  // Invoice reminder (state, attention): day 1–10 and no invoice row this month.
  // Stable `at` = the 1st of the current billing month (UTC instant), so a "seen"
  // stamp taken today permanently covers it rather than it re-appearing unseen.
  if (dayOfMonth >= 1 && dayOfMonth <= 10 && !curMonthInvoiceRes.data) {
    const invoiceReminderAt = new Date(Date.UTC(todayParts.year, todayParts.month - 1, 1)).toISOString()
    items.push({
      id: `invoice-reminder-${currentMonthKey}`,
      kind: 'invoice_reminder',
      text: `Upload your invoice for ${monthLongName(currentMonthKey)}`,
      href: '/billing',
      at: invoiceReminderAt,
      attention: true,
      showTime: false,
    })
  }

  // Hours low / Training ending (state, attention)
  for (const t of trainingRows ?? []) {
    if (t.status !== 'active') continue
    const remaining = Number(t.total_hours) - Number(t.hours_consumed)
    if (remaining < 2) {
      items.push({
        id: `hours-low-${t.id}`,
        kind: 'hours_low',
        // Stable `at` = when the training row last changed (the hours mutation that
        // dropped it under 2h), so a seen-stamp covers it. Falls back to nowIso.
        text: `${nameOf(t.student_id)} has less than 2 hours remaining`,
        href: '/students',
        at: t.updated_at ?? nowIso,
        attention: true,
        showTime: false,
      })
    }
    if (t.end_date && withinDays(t.end_date, 14, todayParts)) {
      // Stable `at` = the moment this training entered the 14-day warning window
      // (end_date minus 14 days, as a UTC instant). Pure Date.UTC on the split date
      // parts — no toISOString on a local date, no tz drift.
      const [ey, em, ed] = t.end_date.split('-').map(Number)
      const enteredWindowAt = new Date(Date.UTC(ey, (em || 1) - 1, ed - 14)).toISOString()
      items.push({
        id: `training-ending-${t.id}`,
        kind: 'training_ending',
        text: `${nameOf(t.student_id)}'s training ends on ${formatDateOnly(t.end_date)}`,
        href: '/students',
        at: enteredWindowAt,
        attention: true,
        showTime: false,
      })
    }
  }

  // Attention items first, then newest first.
  items.sort((a, b) => {
    if (!!a.attention !== !!b.attention) return a.attention ? -1 : 1
    return new Date(b.at).getTime() - new Date(a.at).getTime()
  })

  return items.slice(0, 6)
}

// True iff a date-only 'YYYY-MM-DD' end date is between today and `days` days out
// (inclusive), measured on the calendar in the teacher's timezone. Pure UTC-anchor
// arithmetic on the date parts — no timezone drift, no toISOString.
function withinDays(
  endDateStr: string,
  days: number,
  today: { year: number; month: number; day: number },
): boolean {
  const [ey, em, ed] = endDateStr.split('-').map(Number)
  const endMs = Date.UTC(ey, (em || 1) - 1, ed)
  const todayMs = Date.UTC(today.year, today.month - 1, today.day)
  const diffDays = Math.round((endMs - todayMs) / (24 * 60 * 60 * 1000))
  return diffDays >= 0 && diffDays <= days
}
