import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import TeacherDetailClient from './TeacherDetailClient'
import type {
  AdminConversation,
  TeacherAtAGlance,
  TeacherAtAGlanceLastSignIn,
} from './TeacherDetailClient'
import { recomputeInvoiceAmountsForTeacher } from '@/lib/billing/recomputeAmounts'
import { getBillability, MONTH_BILLING_PREFILTER_STATUSES } from '@/lib/billing/billability'
import { getMonthRangeInTz } from '@/lib/billing/monthRange'
import { requireTz } from '@/lib/time/requireTz'

export default async function TeacherDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  const { id } = await params
  const supabase = createAdminClient()

  // Identify the viewing admin and resolve THEIR timezone — every account sees
  // timestamps in its own tz. Admin-only page, so the viewer is always an admin.
  const sessionClient = await createClient()
  const { data: { user: viewer } } = await sessionClient.auth.getUser()
  let viewerTz: string | null = null
  if (viewer) {
    const { data: viewerProfile } = await supabase
      .from('profiles')
      .select('timezone')
      .eq('id', viewer.id)
      .maybeSingle()
    viewerTz = viewerProfile?.timezone ?? null
  }
  const adminTz = requireTz(viewerTz, 'admin-teacher-detail')

  // Fetch teacher profile — includes sensitive admin-only fields
  const { data: teacher, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !teacher) notFound()

  // ── "At a glance" panel data ────────────────────────────────────────────────
  // Admin-only route, so there is no viewer gate here: everything below renders
  // for whoever got past requireAdmin.
  //
  // Every count runs its OWN head-count query, and NOT ONE is derived from the
  // lessons list fetched below. That list is capped at 50 rows — a cap a teacher
  // passes within a couple of months — so a count tallied off it would stop moving
  // at 50 and stay silently wrong for the rest of the account's life. A head count
  // transfers no rows and cannot freeze.
  //
  // ONE Promise.all, so the whole panel costs a single round-trip wave. The reads
  // already on this page are a serial chain and are left exactly as they are:
  // nothing here reorders, merges or moves one of them.

  // Billing months are TEACHER-local, not viewer-local and not UTC.
  // recomputeInvoiceAmountsForTeacher buckets every lesson with getMonthKeyInTz in
  // the teacher's own zone and refuses outright (TIMEZONE_MISSING) when that zone is
  // absent — so a UTC guess here would drop the first and last hours of the month
  // into the wrong month and show a figure recompute would never produce. No zone
  // means no query at all, and the tile says "Unavailable".
  const teacherTz = (teacher.timezone as string | null) ?? null
  const monthRange = teacherTz ? getMonthRangeInTz(new Date(), teacherTz) : null

  const [
    classesTaughtRes,
    studentNoShowRes,
    teacherNoShowRes,
    lastSignIn,
    monthLessonsRes,
  ] = await Promise.all([
    // Classes taught. 'missed' means the class HAPPENED and the report window was
    // blown: it zeroes teacher PAY, it does not undo the teaching. This is a
    // teaching count, not a pay count, so 'missed' belongs inside it.
    supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', id)
      .in('status', ['completed', 'missed']),
    supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', id)
      .eq('status', 'student_no_show'),
    supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', id)
      .eq('status', 'teacher_no_show'),
    // Last sign-in. LOCKED RULE: auth.admin.* takes the auth.users UUID. For a
    // TEACHER that UUID is profiles.id itself — there is no indirection column,
    // unlike a student, where it is students.auth_user_id and never the table PK.
    // The password override route hands this same route id straight to
    // auth.admin.updateUserById for exactly that reason.
    //
    // BOUNDED, and it must stay that way: this is panel metadata and must never take
    // down the teacher record. Both a returned error and a thrown network failure
    // land on 'unavailable', so nothing escapes this arm.
    (async (): Promise<TeacherAtAGlanceLastSignIn> => {
      try {
        const { data: authData, error: authError } = await supabase.auth.admin.getUserById(id)

        if (authError || !authData?.user) {
          // A missing auth user is NOT 'never': the account could not be read at
          // all, so nothing can be claimed about whether it has ever signed in.
          console.error(
            `[admin teacher detail] last sign-in lookup failed (teacher ${id}):`,
            authError ?? 'auth lookup returned no user'
          )
          return { state: 'unavailable' }
        }
        if (typeof authData.user.last_sign_in_at === 'string') {
          return { state: 'known', at: authData.user.last_sign_in_at }
        }
        // The auth user exists and has never completed a sign-in.
        return { state: 'never' }
      } catch (err) {
        console.error(`[admin teacher detail] last sign-in lookup threw (teacher ${id}):`, err)
        return { state: 'unavailable' }
      }
    })(),
    // Hours this month — MONEY-ADJACENT, so it is recompute's own math on
    // recompute's own inputs and never a parallel definition of "billable": the
    // same column list, the same MONTH_BILLING_PREFILTER_STATUSES prefilter, the
    // same getBillability gate, and a window from the same getMonthRangeInTz.
    monthRange
      ? supabase
          .from('lessons')
          .select('id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by')
          .eq('teacher_id', id)
          .in('status', MONTH_BILLING_PREFILTER_STATUSES)
          .gte('scheduled_at', monthRange.startUtc)
          .lt('scheduled_at', monthRange.endUtc)
      : null,
  ])

  const { count: classesTaughtCount, error: classesTaughtError } = classesTaughtRes
  const { count: studentNoShowCount, error: studentNoShowError } = studentNoShowRes
  const { count: teacherNoShowCount, error: teacherNoShowError } = teacherNoShowRes

  if (classesTaughtError) {
    console.error(`[admin teacher detail] classes-taught count failed (teacher ${id}):`, classesTaughtError)
  }
  if (studentNoShowError) {
    console.error(`[admin teacher detail] student-no-show count failed (teacher ${id}):`, studentNoShowError)
  }
  if (teacherNoShowError) {
    console.error(`[admin teacher detail] teacher-no-show count failed (teacher ${id}):`, teacherNoShowError)
  }

  // A failed count carries null and the tile renders '—'. It must NEVER fall back
  // to 0: 0 is a claim about a clean record, and a read that did not happen cannot
  // make one.
  const classesTaught = classesTaughtError ? null : (classesTaughtCount ?? null)
  const studentNoShows = studentNoShowError ? null : (studentNoShowCount ?? null)
  const teacherNoShows = teacherNoShowError ? null : (teacherNoShowCount ?? null)

  // Billable minutes for the teacher-local month, summed exactly the way recompute
  // sums money over the same rows — only the unit at the end differs.
  let hoursThisMonth: number | null = null
  if (monthLessonsRes) {
    const { data: monthLessons, error: monthLessonsError } = monthLessonsRes
    if (monthLessonsError) {
      console.error(`[admin teacher detail] hours-this-month query failed (teacher ${id}):`, monthLessonsError)
    } else {
      let billableMinutes = 0
      for (const lesson of monthLessons ?? []) {
        const bill = getBillability({
          status: lesson.status,
          scheduledAt: lesson.scheduled_at,
          cancelledAt: lesson.cancelled_at,
          // null for the same reason recompute passes null: the 48hr branch never
          // pays the teacher (billableToTeacher stays false), so the student's
          // cancellation policy cannot change this total and the students join
          // would buy nothing.
          cancellationPolicy: null,
          // Rate 0 is DELIBERATE. billableToTeacher is a status/actor/notice-window
          // decision that never reads the rate, and an HOURS total needs neither a
          // rate nor the lesson_rate_snapshots map recompute builds for money.
          // bill.amount is 0 on every branch here and is never read.
          hourlyRate: 0,
          durationMinutes: lesson.duration_minutes,
          cancelledBy: lesson.cancelled_by ?? null,
          rescheduledBy: lesson.rescheduled_by ?? null,
        })
        if (bill.billableToTeacher) billableMinutes += lesson.duration_minutes
      }
      hoursThisMonth = billableMinutes / 60
    }
  }
  // else: the teacher has no timezone, so the query above never ran and
  // hoursThisMonth stays null — "Unavailable" beats a month bucketed in a guess.

  const teacherAtAGlance: TeacherAtAGlance = {
    signedUpAt: (teacher.created_at as string | null) ?? null,
    lastSignIn,
    classesTaught,
    studentNoShows,
    teacherNoShows,
    hoursThisMonth,
  }

  // Fetch teacher's classes (most recent 50)
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_by,
      rescheduled_by,
      students (
        full_name
      )
    `)
    .eq('teacher_id', id)
    .order('scheduled_at', { ascending: false })
    .limit(50)

  // Sync amount_eur for this teacher so the Invoices tab matches the latest
  // billable-lesson total.
  try {
    await recomputeInvoiceAmountsForTeacher(id)
  } catch (err) {
    console.error('CRITICAL: teacher detail recompute failed', { teacher_id: id, error: err })
  }

  // Fetch teacher's invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, billing_month, amount_eur, status, created_at')
    .eq('teacher_id', id)
    .order('created_at', { ascending: false })

  // Fetch history log
  const { data: history } = await supabase
    .from('teacher_history_log')
    .select('id, field_name, old_value, new_value, changed_by, changed_at')
    .eq('teacher_id', id)
    .order('changed_at', { ascending: false })
    .limit(50)

  // Flatten nested student names on lessons
  const flatLessons = (lessons || []).map((l) => ({
    ...l,
    student_name: Array.isArray(l.students)
      ? (l.students[0] as { full_name: string } | undefined)?.full_name ?? '—'
      : (l.students as { full_name: string } | null)?.full_name ?? '—',
  }))

  // ── Purge eligibility: check all linked students are 'former' ───────────────
  const { data: linkedLessonRows } = await supabase
    .from('lessons')
    .select('student_id')
    .eq('teacher_id', id)
    .not('student_id', 'is', null)

  const linkedStudentIds = [
    ...new Set(
      (linkedLessonRows || []).map((l: { student_id: string }) => l.student_id)
    ),
  ]

  let purgeBlockedBy: string[] = []
  if (linkedStudentIds.length > 0) {
    const { data: nonFormerStudents } = await supabase
      .from('students')
      .select('full_name')
      .in('id', linkedStudentIds)
      .neq('status', 'former')
    purgeBlockedBy = (nonFormerStudents || []).map((s: { full_name: string }) => s.full_name)
  }

  // ── Messages: fetch all teacher↔student conversations ──────────────────────
  // Only select explicit columns — never select('*') on messages
  const { data: rawMessages } = await supabase
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
    .or(
      `and(sender_id.eq.${id},receiver_type.eq.student),` +
      `and(receiver_id.eq.${id},sender_type.eq.student)`
    )
    .order('created_at', { ascending: true })
    .limit(500)

  const msgs = rawMessages ?? []

  // Collect unique student IDs
  const studentIds = [
    ...new Set(
      msgs.map((m) => (m.sender_type === 'student' ? m.sender_id : m.receiver_id))
    ),
  ]

  // Fetch student names + photos
  const { data: students } = studentIds.length > 0
    ? await supabase
      .from('students')
      .select('id, full_name, photo_url')
      .in('id', studentIds)
    : { data: [] as { id: string; full_name: string; photo_url: string | null }[] }

  const studentMap = Object.fromEntries(
    (students ?? []).map((s) => [s.id, s])
  )

  // Group messages by student into conversations
  const convMap = new Map<string, typeof msgs>()
  for (const msg of msgs) {
    const sid = msg.sender_type === 'student' ? msg.sender_id : msg.receiver_id
    if (!convMap.has(sid)) convMap.set(sid, [])
    convMap.get(sid)!.push(msg)
  }

  const conversations: AdminConversation[] = Array.from(convMap.entries())
    .map(([sid, messages]) => ({
      contactId: sid,
      contactName: studentMap[sid]?.full_name ?? 'Unknown Student',
      contactPhotoUrl: studentMap[sid]?.photo_url ?? null,
      messages: messages.map((m) => ({
        id: m.id,
        sender_id: m.sender_id,
        sender_type: m.sender_type,
        receiver_id: m.receiver_id,
        receiver_type: m.receiver_type,
        content: m.content,
        attachments: (m.attachments as Array<{ url: string; filename: string; size: number }>) ?? [],
        read_at: m.read_at,
        created_at: m.created_at,
      })),
    }))
    .sort((a, b) => {
      const lastA = a.messages[a.messages.length - 1]?.created_at ?? ''
      const lastB = b.messages[b.messages.length - 1]?.created_at ?? ''
      return lastB.localeCompare(lastA)
    })

  return (
    <TeacherDetailClient
      teacher={teacher}
      lessons={flatLessons}
      invoices={invoices || []}
      history={history || []}
      conversations={conversations}
      purgeBlockedBy={purgeBlockedBy}
      adminTz={adminTz}
      teacherAtAGlance={teacherAtAGlance}
    />
  )
}
