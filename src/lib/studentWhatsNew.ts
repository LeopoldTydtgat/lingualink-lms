// src/lib/studentWhatsNew.ts
//
// Derives the student-scoped "What's New" feed for the student portal bell.
// Sibling of src/lib/whatsNew.ts (the teacher feed) — same item shape, 7-day
// event window, unwindowed state sources, 6-item cap, attention-first ordering
// and dismiss-before-cap semantics; only the sources and perspective differ.
//
// IDENTITY RULE (the one place a copied teacher pattern silently breaks):
//   - students.id (table PK) is what lessons.student_id, assignments.student_id
//     and trainings.student_id reference — passed in as `studentId`. Every feed
//     query below scopes on THIS id.
//   - auth.uid() (= students.auth_user_id) is what student_whats_new_dismissals
//     .student_auth_id and the students.whats_new_seen_at write key on — passed
//     in as `authUserId`. Only the dismissals read below uses THIS id.
//   Never mix the two: they are different uuids for the same person.
//
// Dismissed items (per-student rows in student_whats_new_dismissals, keyed by
// the item id) are filtered out BEFORE the cap, so dismissing one item surfaces
// the next older one rather than leaving a gap.
//
// Date rules (root CLAUDE.md): class time is formatted in the student's account
// timezone via utcInstantToTzParts — never toISOString for local dates, never
// toLocaleTimeString. Date-only columns (end_date) are split on their literal
// 'YYYY-MM-DD' string, never round-tripped through Date.

import type { createClient } from '@/lib/supabase/server'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'

type ServerClient = Awaited<ReturnType<typeof createClient>>

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

// "Wed 22 Jul, 08:00" in the student's account timezone. Falls back to UTC on a
// missing/invalid tz rather than throwing (this feeds a header bell with no
// error boundary above it, same posture as the teacher feed's formatClassMoment).
function formatClassMoment(iso: string, tz: string | null): string {
  const zone = tz && isValidTimeZone(tz) ? tz : 'UTC'
  const p = utcInstantToTzParts(iso, zone)
  return `${WEEKDAYS[p.weekday]} ${pad(p.day)} ${MONTHS_SHORT[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)}`
}

// "22 Jul 2026" from a literal date-only 'YYYY-MM-DD' string. No Date round-trip.
function formatDateOnly(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${d} ${MONTHS_SHORT[(m || 1) - 1]} ${y}`
}

export async function fetchStudentWhatsNew(
  supabase: ServerClient,
  studentId: string,
  authUserId: string,
): Promise<WhatsNewItem[]> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const sinceIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Student timezone — needed to format class times. Explicit column list
  // (students carries admin-only columns; never select '*'). RLS scopes the read
  // to the student's own row.
  const { data: studentRow } = await supabase
    .from('students')
    .select('timezone')
    .eq('id', studentId)
    .maybeSingle()
  const tz: string | null = studentRow?.timezone ?? null
  const tzZone = tz && isValidTimeZone(tz) ? tz : 'UTC'
  const todayParts = utcInstantToTzParts(nowIso, tzZone)

  // ── Source queries (student-scoped on students.id) ──────────────────────────
  const [
    cancelledRes,
    rescheduledRes,
    assignedRes,
    trainingsRes,
    dismissalsRes,
  ] = await Promise.all([
    // Cancelled by teacher or admin — never the student's own cancellations
    // (mirror of the teacher feed, which only surfaces the counterpart's
    // actions). A student reschedule's dead old leg carries
    // cancelled_by='student' (cancel_lesson_atomic), so reschedule legs are
    // excluded by this actor filter too.
    supabase
      .from('lessons')
      .select('id, scheduled_at, cancelled_at, cancelled_by')
      .eq('student_id', studentId)
      .in('cancelled_by', ['teacher', 'admin'])
      .gte('cancelled_at', sinceIso),
    // Rescheduled by admin — an in-place move: the row keeps its id and carries
    // the NEW scheduled_at (api/admin/classes/[id] NEW341). rescheduled_by is
    // only ever 'student' | 'admin' (lib/lessons/statusLabel.ts); the student's
    // own reschedules are not notified back to them.
    supabase
      .from('lessons')
      .select('id, scheduled_at, rescheduled_at')
      .eq('student_id', studentId)
      .eq('rescheduled_by', 'admin')
      .gte('rescheduled_at', sinceIso),
    // Homework assigned (event, windowed on assigned_at).
    supabase
      .from('assignments')
      .select('id, study_sheet_id, assigned_at')
      .eq('student_id', studentId)
      .gte('assigned_at', sinceIso),
    // Active trainings — hours-low / ending checks (state, not windowed).
    supabase
      .from('trainings')
      .select('id, total_hours, hours_consumed, end_date, updated_at')
      .eq('student_id', studentId)
      .eq('status', 'active'),
    // Per-student dismissed item keys — keyed on auth.uid(), NOT students.id
    // (see identity rule above). RLS on student_whats_new_dismissals already
    // scopes to the student; the explicit eq mirrors every other query here and
    // keeps the intent obvious.
    supabase
      .from('student_whats_new_dismissals')
      .select('item_key')
      .eq('student_auth_id', authUserId),
  ])

  // Set of dismissed item keys (== WhatsNewItem.id). Used to drop items before
  // the slice, so dismissing one reveals the next older item.
  const dismissedKeys = new Set((dismissalsRes.data ?? []).map((r) => r.item_key))

  // Sheet titles for the homework items — one batched query, explicit columns.
  const assignedRows = assignedRes.data ?? []
  const sheetIds = [...new Set(
    assignedRows
      .map((a) => a.study_sheet_id)
      .filter((id): id is string => !!id),
  )]
  const { data: sheetRows } = sheetIds.length
    ? await supabase.from('study_sheets').select('id, title').in('id', sheetIds)
    : { data: [] as Array<{ id: string; title: string }> }
  const titleById = new Map((sheetRows ?? []).map((s) => [s.id, s.title]))

  // ── Build items ─────────────────────────────────────────────────────────────
  const items: WhatsNewItem[] = []

  // Class cancelled by teacher/admin (event, windowed). Teacher cancellations
  // always refund hours (cancel_lesson_atomic is called with p_should_refund:
  // true from the teacher action), so that variant says so; admin cancellations
  // may or may not refund, so no claim is made.
  for (const l of cancelledRes.data ?? []) {
    if (!l.cancelled_at) continue
    items.push({
      id: `cancelled-${l.id}`,
      kind: 'class_cancelled',
      text: l.cancelled_by === 'teacher'
        ? `Your teacher cancelled your class on ${formatClassMoment(l.scheduled_at, tz)} - your hours were refunded`
        : `Your class on ${formatClassMoment(l.scheduled_at, tz)} was cancelled`,
      href: '/student/my-classes',
      at: l.cancelled_at,
    })
  }

  // Class rescheduled by admin (event, windowed). scheduled_at is the NEW time
  // (in-place move). The item key includes rescheduled_at because the SAME row
  // mutates on every admin move — a bare `rescheduled-${id}` key would let one
  // dismissal permanently swallow every later reschedule of that lesson.
  for (const l of rescheduledRes.data ?? []) {
    if (!l.rescheduled_at) continue
    items.push({
      id: `rescheduled-${l.id}-${l.rescheduled_at}`,
      kind: 'class_rescheduled',
      text: `Your class was rescheduled to ${formatClassMoment(l.scheduled_at, tz)}`,
      href: '/student/my-classes',
      at: l.rescheduled_at,
    })
  }

  // Homework assigned (event, windowed).
  for (const a of assignedRows) {
    if (!a.assigned_at) continue
    const title = a.study_sheet_id ? titleById.get(a.study_sheet_id) : undefined
    items.push({
      id: `homework-${a.id}`,
      kind: 'homework_assigned',
      text: title ? `New exercise assigned: ${title}` : 'New exercises assigned by your teacher',
      href: '/student/study',
      at: a.assigned_at,
    })
  }

  // Hours low / Training ending (state, attention). Same stable synthetic
  // timestamps as the teacher feed so a "seen" stamp taken today permanently
  // covers them rather than them re-appearing unseen.
  for (const t of trainingsRes.data ?? []) {
    const remaining = Number(t.total_hours) - Number(t.hours_consumed)
    if (remaining < 2) {
      items.push({
        id: `hours-low-${t.id}`,
        kind: 'hours_low',
        // Stable `at` = when the training row last changed (the hours mutation
        // that dropped it under 2h), so a seen-stamp covers it. Falls back to nowIso.
        text: 'You have less than 2 hours remaining',
        href: '/student/account',
        at: t.updated_at ?? nowIso,
        attention: true,
        showTime: false,
      })
    }
    if (t.end_date && withinDays(t.end_date, 14, todayParts)) {
      // Stable `at` = the moment this training entered the 14-day warning window
      // (end_date minus 14 days, as a UTC instant). Pure Date.UTC on the split
      // date parts — no toISOString on a local date, no tz drift.
      const [ey, em, ed] = t.end_date.split('-').map(Number)
      const enteredWindowAt = new Date(Date.UTC(ey, (em || 1) - 1, ed - 14)).toISOString()
      items.push({
        id: `training-ending-${t.id}`,
        kind: 'training_ending',
        text: `Your training ends on ${formatDateOnly(t.end_date)}`,
        href: '/student/account',
        at: enteredWindowAt,
        attention: true,
        showTime: false,
      })
    }
  }

  // Drop dismissed items BEFORE the cap so dismissing surfaces the next older
  // item instead of leaving a gap. Then sort (attention first, newest first) and
  // slice to the display cap.
  const visibleItems = items.filter((i) => !dismissedKeys.has(i.id))

  visibleItems.sort((a, b) => {
    if (!!a.attention !== !!b.attention) return a.attention ? -1 : 1
    return new Date(b.at).getTime() - new Date(a.at).getTime()
  })

  return visibleItems.slice(0, 6)
}

// True iff a date-only 'YYYY-MM-DD' end date is between today and `days` days out
// (inclusive), measured on the calendar in the student's timezone. Pure UTC-anchor
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
