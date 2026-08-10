import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { requireStaff } from '@/lib/auth/requireStaff'
import StudentDetailClient from './StudentDetailClient'
import type {
  AdminConversation,
  Assignment,
  MaterialHomework,
  MaterialSheetOption,
} from './StudentDetailClient'

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  let isStaffView = false
  // The viewer is the admin OR the staff user, whichever gate passed — their own
  // profiles.timezone is what every instant on this page is rendered in.
  let viewerId: string
  if (adminUser) {
    viewerId = adminUser.id
  } else {
    const staffUser = await requireStaff()
    if (!staffUser) redirect('/dashboard')
    isStaffView = true
    viewerId = staffUser.id
  }

  const { id } = await params

  // The route param is interpolated raw into PostgREST filter strings below
  // (the messages .or(...) in particular), so it must be proven to be a uuid
  // before ANY query runs — not after. A non-uuid id can never match a row, so
  // notFound() is the correct outcome as well as the safe one.
  if (!z.string().uuid().safeParse(id).success) notFound()

  const supabase = createAdminClient()

  // Resolve the viewing account's timezone — every account sees timestamps in its
  // own zone. Times are stored in UTC and formatted client-side with an explicit
  // Intl timeZone, which is deterministic on server and client (no hydration
  // mismatch). This page does not use requireTz, so a missing profile row or an
  // unset column falls back to UTC rather than throwing: a timezone is display
  // metadata here and must never block a student record from loading.
  const { data: viewerProfile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', viewerId)
    .maybeSingle()

  const adminTz = viewerProfile?.timezone ?? 'UTC'

  // Fetch student with company and active training + assigned teachers.
  // Staff must never receive the full row — explicit column list excluding
  // admin-only fields (admin_notes, cancellation_policy, customer_number,
  // date_of_birth, follow-up and billing fields). Two literal selects (not an
  // interpolated column list) so the typed client can parse each query.
  const { data: student, error } = isStaffView
    ? await supabase
        .from('students')
        .select(`
          id, full_name, email, phone, photo_url, status, timezone, language_preference, native_language, learning_language, current_fluency_level, learning_goals, interests, teacher_notes, email_bounced_at, email_bounce_reason,
          companies (
            id,
            name
          ),
          trainings (
            id,
            package_name,
            package_type,
            total_hours,
            hours_consumed,
            end_date,
            status,
            created_at,
            training_teachers (
              teacher_id,
              profiles:teacher_id (
                id,
                full_name
              )
            )
          )
        `)
        .eq('id', id)
        .single()
    : await supabase
        .from('students')
        .select(`
      *,
      companies (
        id,
        name
      ),
      trainings (
        id,
        package_name,
        package_type,
        total_hours,
        hours_consumed,
        end_date,
        status,
        created_at,
        training_teachers (
          teacher_id,
          profiles:teacher_id (
            id,
            full_name
          )
        )
      )
    `)
        .eq('id', id)
        .single()

  if (error || !student) notFound()

  // Flatten company
  const company = Array.isArray(student.companies)
    ? student.companies[0]
    : student.companies

  // Flatten training — use active training or most recent
  // Deterministic pick: newest training first (created_at DESC), then prefer
  // status 'active', else newest overall. Without the sort, PostgREST nested
  // rows arrive in arbitrary order and activeTrain.id (which feeds training_id
  // on the edit PATCH, an hours-mutation path) could silently target a
  // different training once multi-training students exist.
  const trainingsArr = (Array.isArray(student.trainings) ? student.trainings : [])
    .slice()
    .sort((a: { created_at: string | null }, b: { created_at: string | null }) =>
      (b.created_at ?? '').localeCompare(a.created_at ?? '')
    )
  const activeTrain =
    trainingsArr.find((t: { status: string | null }) => t.status === 'active') ??
    trainingsArr[0] ??
    null

  // STRICT active check, deliberately NOT `activeTrain !== null`: activeTrain
  // falls back to the newest training of ANY status so the Training card still
  // shows something for a student whose package ended. The Create Training form
  // and the hours controls must key off the real thing — offering a second
  // ACTIVE training would be refused by create_training_atomic and by the
  // one_active_training_per_student index, and adding hours to a finished
  // training would move a balance nobody can spend.
  const hasActiveTraining = trainingsArr.some(
    (t: { status: string | null }) => t.status === 'active'
  )

  // Assignable-teacher picks for the Create Training form. Same role/status
  // filter as students/new/page.tsx:31-36 and edit/page.tsx:109-114 — the
  // canonical definition of an assignable teacher, and the same set
  // POST /api/admin/students/[id]/trainings re-validates against, so the form
  // can never offer a pick the route rejects. Skipped entirely when the form
  // will not render: staff get no mutation entry points on this page, and a
  // student with an active training gets no form.
  const needTeacherOptions = !isStaffView && !hasActiveTraining

  const { data: teacherRows, error: teacherRowsError } = needTeacherOptions
    ? await supabase
        .from('profiles')
        .select('id, full_name')
        .in('role', ['teacher', 'admin'])
        .eq('status', 'current')
        .order('full_name')
    : { data: null, error: null }

  if (teacherRowsError) {
    console.error('[student detail] assignable teachers query failed:', teacherRowsError)
  }

  const teacherOptions: { id: string; full_name: string }[] = (teacherRows ?? []).map(
    (t: { id: string; full_name: string }) => ({ id: t.id, full_name: t.full_name })
  )

  // An empty picker reads as "there are no teachers", which is exactly what a
  // failed read also produces. Zero teachers is a legal selection here, so the
  // form is not blocked — but it must say the list could not be loaded rather
  // than let an admin create a training with nobody attached by accident.
  const teacherOptionsLoadFailed =
    needTeacherOptions && (Boolean(teacherRowsError) || !teacherRows)

  // Flatten assigned teachers from training_teachers
  const assignedTeachers: { id: string; full_name: string }[] = []
  if (activeTrain) {
    const ttArr = Array.isArray(activeTrain.training_teachers)
      ? activeTrain.training_teachers
      : []
    for (const tt of ttArr) {
      const profile = Array.isArray(tt.profiles) ? tt.profiles[0] : tt.profiles
      if (profile?.id && profile?.full_name) {
        if (!assignedTeachers.find((t) => t.id === profile.id)) {
          assignedTeachers.push({ id: profile.id, full_name: profile.full_name })
        }
      }
    }
  }

  // Fetch lessons for this student (most recent 50)
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_by,
      rescheduled_by,
      profiles:teacher_id (
        full_name
      )
    `)
    .eq('student_id', id)
    .order('scheduled_at', { ascending: false })
    .limit(50)

  // Flatten teacher name on each lesson
  const flatLessons = (lessons || []).map((l) => ({
    id: l.id,
    scheduled_at: l.scheduled_at,
    duration_minutes: l.duration_minutes,
    status: l.status,
    cancelled_by: l.cancelled_by ?? null,
    rescheduled_by: l.rescheduled_by ?? null,
    teacher_name: Array.isArray(l.profiles)
      ? (l.profiles[0] as { full_name: string } | undefined)?.full_name ?? '—'
      : (l.profiles as { full_name: string } | null)?.full_name ?? '—',
  }))

  // Fetch hours log for this student (admin only — staff view skips it)
  const { data: hoursLog } = isStaffView
    ? { data: null }
    : await supabase
        .from('hours_log')
        .select('*')
        .eq('student_id', id)
        .order('created_at', { ascending: false })

  // Fetch reports via lesson IDs belonging to this student
  // (staff see these read-only in the Reports tab)
  const lessonIds = flatLessons.map((l) => l.id)
  let reports: {
    id: string
    happened: boolean | null
    feedback: string | null
    status: string
    created_at: string
    class_id: string
    lesson_scheduled_at: string | null
    teacher_name: string | null
  }[] = []

  if (lessonIds.length > 0) {
    const { data: rawReports, error: reportsError } = await supabase
      .from('reports')
      .select(`
        id,
        did_class_happen,
        feedback_text,
        status,
        created_at,
        lesson_id,
        lessons!inner (
          id,
          scheduled_at,
          profiles:teacher_id (
            full_name
          )
        )
      `)
      .in('lesson_id', lessonIds)
      .order('created_at', { ascending: false })
      .limit(50)

    // Bound and logged, never thrown: a failed reports read leaves the Reports
    // tab empty but must not take down the whole student record — every other
    // tab on this page stays useful.
    if (reportsError) {
      console.error('[admin/students/[id]] reports query failed:', reportsError)
    }

    reports = (rawReports || []).map((r) => {
      const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons
      const teacherProfile = lesson
        ? Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles
        : null
      return {
        id: r.id,
        happened: r.did_class_happen,
        feedback: r.feedback_text,
        status: r.status,
        created_at: r.created_at,
        class_id: r.lesson_id,
        lesson_scheduled_at: lesson?.scheduled_at ?? null,
        teacher_name: teacherProfile?.full_name ?? null,
      }
    })
  }

  // Fetch reviews submitted by this student
  // (staff see these read-only in the Reviews tab)
  const { data: reviews } = await supabase
    .from('student_reviews')
    .select(`
      id,
      rating,
      review_text,
      submitted_at,
      admin_edited_text,
      moderated_by_admin,
      profiles:teacher_id (
        full_name
      )
    `)
    .eq('student_id', id)
    .order('submitted_at', { ascending: false })

  const flatReviews = (reviews || []).map((r) => ({
    id: r.id,
    rating: r.rating,
    review_text: r.review_text,
    submitted_at: r.submitted_at,
    admin_edited_text: r.admin_edited_text,
    moderated_by_admin: r.moderated_by_admin,
    teacher_name: Array.isArray(r.profiles)
      ? (r.profiles[0] as { full_name: string } | undefined)?.full_name ?? '—'
      : (r.profiles as { full_name: string } | null)?.full_name ?? '—',
  }))

  // Fetch assignments for this student joined to study sheet metadata
  // (admin only — staff view skips it)
  const { data: rawAssignments } = isStaffView
    ? { data: null }
    : await supabase
        .from('assignments')
        .select('id, assigned_at, lesson_id, study_sheets!assignments_study_sheet_id_fkey(title, category, level)')
        .eq('student_id', id)
        .order('assigned_at', { ascending: false })

  type RawSheetJoin = { title: string; category: string; level: string } | null

  const assignments: Assignment[] = (rawAssignments || []).map((a) => {
    const rawSheet: unknown = Array.isArray(a.study_sheets) ? a.study_sheets[0] : a.study_sheets
    const sheet = rawSheet as RawSheetJoin
    return {
      id: a.id,
      assigned_at: a.assigned_at as string,
      lesson_id: a.lesson_id as string | null,
      study_sheet: {
        title: sheet?.title ?? '—',
        category: sheet?.category ?? '—',
        level: sheet?.level ?? '—',
      },
    }
  })

  // ── Teaching-material homework grants (material_assignments) ────────────────
  // Admin only, like the study-sheet assignments above: staff never see the
  // Assignments tab, so both reads below are skipped entirely for them.
  //
  // Service role, matching every other read on this page. Explicit column list,
  // never select('*'): material_assignments carries a column-level UPDATE grant
  // (annotations, updated_at only). Revoked rows are deliberately KEPT and shown
  // with a Revoked badge — revoke is semantic (revoked_at stamped, never
  // deleted) and the row is the audit trail of what was handed out.
  //
  // The error is BOUND and surfaced to the client as its own flag: a failed
  // lookup must never render as "this student has no homework".
  type RawMaterialRow = {
    id: string
    study_sheet_id: string
    attachment_name: string
    page_start: number | null
    page_end: number | null
    assigned_at: string
    revoked_at: string | null
  }

  const { data: rawMaterialHomework, error: materialHomeworkError } = isStaffView
    ? { data: null, error: null }
    : await supabase
        .from('material_assignments')
        .select('id, study_sheet_id, attachment_name, page_start, page_end, assigned_at, revoked_at')
        .eq('student_id', id)
        .order('assigned_at', { ascending: false })

  if (materialHomeworkError) {
    console.error(
      `[admin student detail] material_assignments lookup failed (student ${id}):`,
      materialHomeworkError
    )
  }

  const materialHomeworkLoadFailed = Boolean(materialHomeworkError)
  const materialRows = (
    materialHomeworkError ? [] : rawMaterialHomework ?? []
  ) as RawMaterialRow[]

  // Sheet titles for those grants. A failed lookup here is a soft degradation,
  // not an error state: every row falls back to the granted filename, which is
  // stored on the row itself and is always present.
  const materialSheetIds = [...new Set(materialRows.map((m) => m.study_sheet_id))]
  const materialTitles = new Map<string, string>()

  if (materialSheetIds.length > 0) {
    const { data: materialTitleRows, error: materialTitleError } = await supabase
      .from('study_sheets')
      .select('id, title')
      .in('id', materialSheetIds)

    if (materialTitleError) {
      console.error(
        `[admin student detail] material sheet titles lookup failed (student ${id}):`,
        materialTitleError
      )
    }

    for (const row of (materialTitleRows ?? []) as { id: string; title: string | null }[]) {
      if (typeof row.title === 'string' && row.title.length > 0) {
        materialTitles.set(row.id, row.title)
      }
    }
  }

  const materialHomework: MaterialHomework[] = materialRows.map((row) => ({
    id: row.id,
    sheet_title: materialTitles.get(row.study_sheet_id) ?? null,
    attachment_name: row.attachment_name,
    page_start: row.page_start,
    page_end: row.page_end,
    assigned_at: row.assigned_at,
    revoked_at: row.revoked_at,
  }))

  // Assignable teaching material for the assign modal: active, audience='staff'.
  // Those are exactly the two conditions POST /api/admin/material-assignments
  // re-applies before it will issue a grant, so the picker cannot offer
  // something the route would refuse. PDF filtering is left to the modal, which
  // needs the non-PDF rows in order to disable them with a reason.
  type RawMaterialSheetRow = { id: string; title: string | null; attachments: unknown }

  const { data: rawMaterialSheets, error: materialSheetsError } = isStaffView
    ? { data: null, error: null }
    : await supabase
        .from('study_sheets')
        .select('id, title, attachments')
        .eq('is_active', true)
        .eq('audience', 'staff')
        .order('title')

  if (materialSheetsError) {
    console.error('[admin student detail] teaching material list failed:', materialSheetsError)
  }

  // An empty picker reads as "there is no teaching material", which is exactly
  // what a failed read also produces. The flag carries that distinction to the
  // client so the Assign button can be disabled with the real reason.
  const materialSheetsLoadFailed = Boolean(materialSheetsError)

  const materialSheetRows = (
    materialSheetsError ? [] : rawMaterialSheets ?? []
  ) as RawMaterialSheetRow[]

  const materialSheets: MaterialSheetOption[] = materialSheetRows.map((row) => ({
    id: row.id,
    title: row.title ?? 'Untitled material',
    attachments: Array.isArray(row.attachments)
      ? (row.attachments as { name: string; type: string }[]).filter(
          (att) => att && typeof att.name === 'string' && typeof att.type === 'string'
        )
      : [],
  }))

  // ── Purge eligibility: check all linked teachers are 'former' ───────────────
  // (admin only — staff view skips it, purge controls are hidden)
  //
  // ADVISORY ONLY. The authoritative fail-closed gate is purge_student_atomic,
  // called by DELETE /api/admin/students/[id]; this pre-check exists purely to
  // disable the button and name the blocking teachers before the admin clicks.
  // Because an empty purgeBlockedBy renders as "nothing is blocking", a failed
  // query must NOT fall through to that state: if either read errors we cannot
  // prove eligibility, so purgePreflightFailed fails the UI closed instead.
  let purgePreflightFailed = false

  const { data: linkedLessonRows, error: linkedLessonsError } = isStaffView
    ? { data: null, error: null }
    : await supabase
        .from('lessons')
        .select('teacher_id')
        .eq('student_id', id)
        .not('teacher_id', 'is', null)

  if (linkedLessonsError) {
    console.error('[student purge preflight] linked lessons query failed:', linkedLessonsError)
    purgePreflightFailed = true
  }

  const linkedTeacherIds = [
    ...new Set(
      (linkedLessonRows || []).map((l: { teacher_id: string }) => l.teacher_id)
    ),
  ]

  let purgeBlockedBy: string[] = []
  if (!purgePreflightFailed && linkedTeacherIds.length > 0) {
    const { data: nonFormerTeachers, error: nonFormerTeachersError } = await supabase
      .from('profiles')
      .select('full_name')
      .in('id', linkedTeacherIds)
      .neq('status', 'former')

    if (nonFormerTeachersError || !nonFormerTeachers) {
      console.error(
        '[student purge preflight] non-former teachers query failed:',
        nonFormerTeachersError ?? 'query returned null data'
      )
      purgePreflightFailed = true
      purgeBlockedBy = []
    } else {
      purgeBlockedBy = nonFormerTeachers.map((t: { full_name: string }) => t.full_name)
    }
  }

  // ── Messages: fetch all student conversations (admin only — staff skips) ───
  // Only select explicit columns — never select('*') on messages
  const { data: rawMessages } = isStaffView
    ? { data: null }
    : await supabase
        .from('messages')
        .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
        .or(`sender_id.eq.${id},receiver_id.eq.${id}`)
        .order('created_at', { ascending: true })
        .limit(500)

  const msgs = rawMessages ?? []

  // The other party in each message is always a teacher/admin (a profile)
  const profileIds = [
    ...new Set(
      msgs.map((m) => (m.sender_id === id ? m.receiver_id : m.sender_id))
    ),
  ]

  const { data: profiles } = profileIds.length > 0
    ? await supabase
      .from('profiles')
      .select('id, full_name, photo_url')
      .in('id', profileIds)
    : { data: [] as { id: string; full_name: string; photo_url: string | null }[] }

  const profileMap = Object.fromEntries(
    (profiles ?? []).map((p) => [p.id, p])
  )

  // Group messages by teacher/profile into conversations
  const convMap = new Map<string, typeof msgs>()
  for (const msg of msgs) {
    const pid = msg.sender_id === id ? msg.receiver_id : msg.sender_id
    if (!convMap.has(pid)) convMap.set(pid, [])
    convMap.get(pid)!.push(msg)
  }

  const conversations: AdminConversation[] = Array.from(convMap.entries())
    .map(([pid, messages]) => ({
      contactId: pid,
      contactName: profileMap[pid]?.full_name ?? 'Unknown',
      contactPhotoUrl: profileMap[pid]?.photo_url ?? null,
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

  const hoursRemaining = activeTrain
    ? Number(activeTrain.total_hours) - Number(activeTrain.hours_consumed)
    : null

  return (
    <StudentDetailClient
      student={student}
      companyName={company?.name ?? null}
      activeTrain={activeTrain}
      hasActiveTraining={hasActiveTraining}
      teacherOptions={teacherOptions}
      teacherOptionsLoadFailed={teacherOptionsLoadFailed}
      hoursRemaining={hoursRemaining}
      assignedTeachers={assignedTeachers}
      lessons={flatLessons}
      hoursLog={hoursLog || []}
      reports={reports}
      reviews={flatReviews}
      conversations={conversations}
      purgeBlockedBy={purgeBlockedBy}
      purgePreflightFailed={purgePreflightFailed}
      assignments={assignments}
      materialHomework={materialHomework}
      materialHomeworkLoadFailed={materialHomeworkLoadFailed}
      materialSheets={materialSheets}
      materialSheetsLoadFailed={materialSheetsLoadFailed}
      isStaffView={isStaffView}
      adminTz={adminTz}
    />
  )
}
