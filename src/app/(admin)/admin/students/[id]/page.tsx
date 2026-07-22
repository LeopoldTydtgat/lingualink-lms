import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { requireStaff } from '@/lib/auth/requireStaff'
import StudentDetailClient from './StudentDetailClient'
import type { AdminConversation, Assignment } from './StudentDetailClient'

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  let isStaffView = false
  if (!adminUser) {
    const staffUser = await requireStaff()
    if (!staffUser) redirect('/dashboard')
    isStaffView = true
  }

  const { id } = await params
  const supabase = createAdminClient()

  // Fetch student with company and active training + assigned teachers.
  // Staff must never receive the full row — explicit column list excluding
  // admin-only fields (admin_notes, cancellation_policy, customer_number,
  // date_of_birth, follow-up and billing fields). Two literal selects (not an
  // interpolated column list) so the typed client can parse each query.
  const { data: student, error } = isStaffView
    ? await supabase
        .from('students')
        .select(`
          id, full_name, email, phone, photo_url, status, timezone, language_preference, native_language, learning_language, current_fluency_level, self_assessed_level, learning_goals, interests, teacher_notes, email_bounced_at, email_bounce_reason,
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
  const trainingsArr = Array.isArray(student.trainings) ? student.trainings : []
  const activeTrain =
    trainingsArr.find((t: { status: string | null }) => t.status === 'active') ??
    trainingsArr[0] ??
    null

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
  const lessonIds = flatLessons.map((l) => l.id)
  let reports: {
    id: string
    happened: boolean | null
    feedback: string | null
    created_at: string
    class_id: string
    lesson_scheduled_at: string | null
    teacher_name: string | null
  }[] = []

  if (!isStaffView && lessonIds.length > 0) {
    const { data: rawReports } = await supabase
      .from('reports')
      .select(`
        id,
        happened,
        feedback,
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

    reports = (rawReports || []).map((r) => {
      const lesson = Array.isArray(r.lessons) ? r.lessons[0] : r.lessons
      const teacherProfile = lesson
        ? Array.isArray(lesson.profiles) ? lesson.profiles[0] : lesson.profiles
        : null
      return {
        id: r.id,
        happened: r.happened,
        feedback: r.feedback,
        created_at: r.created_at,
        class_id: r.lesson_id,
        lesson_scheduled_at: lesson?.scheduled_at ?? null,
        teacher_name: teacherProfile?.full_name ?? null,
      }
    })
  }

  // Fetch reviews submitted by this student (admin only — staff view skips it)
  const { data: reviews } = isStaffView
    ? { data: null }
    : await supabase
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

  // ── Purge eligibility: check all linked teachers are 'former' ───────────────
  // (admin only — staff view skips it, purge controls are hidden)
  const { data: linkedLessonRows } = isStaffView
    ? { data: null }
    : await supabase
        .from('lessons')
        .select('teacher_id')
        .eq('student_id', id)
        .not('teacher_id', 'is', null)

  const linkedTeacherIds = [
    ...new Set(
      (linkedLessonRows || []).map((l: { teacher_id: string }) => l.teacher_id)
    ),
  ]

  let purgeBlockedBy: string[] = []
  if (linkedTeacherIds.length > 0) {
    const { data: nonFormerTeachers } = await supabase
      .from('profiles')
      .select('full_name')
      .in('id', linkedTeacherIds)
      .neq('status', 'former')
    purgeBlockedBy = (nonFormerTeachers || []).map((t: { full_name: string }) => t.full_name)
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
      hoursRemaining={hoursRemaining}
      assignedTeachers={assignedTeachers}
      lessons={flatLessons}
      hoursLog={hoursLog || []}
      reports={reports}
      reviews={flatReviews}
      conversations={conversations}
      purgeBlockedBy={purgeBlockedBy}
      assignments={assignments}
      isStaffView={isStaffView}
    />
  )
}
