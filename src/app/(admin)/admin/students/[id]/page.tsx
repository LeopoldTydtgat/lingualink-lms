import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import StudentDetailClient from './StudentDetailClient'
import type { AdminConversation } from './StudentDetailClient'

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createAdminClient()

  // Fetch student with company and active training + assigned teachers
  const { data: student, error } = await supabase
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
  const activeTrain = trainingsArr.find((t: any) => t.status === 'active') ?? trainingsArr[0] ?? null

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
    teacher_name: Array.isArray(l.profiles)
      ? (l.profiles[0] as { full_name: string } | undefined)?.full_name ?? '—'
      : (l.profiles as { full_name: string } | null)?.full_name ?? '—',
  }))

  // Fetch hours log for this student
  const { data: hoursLog } = await supabase
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

  if (lessonIds.length > 0) {
    const { data: rawReports } = await supabase
      .from('reports')
      .select(`
        id,
        happened,
        feedback,
        created_at,
        class_id,
        lessons!inner (
          id,
          scheduled_at,
          profiles:teacher_id (
            full_name
          )
        )
      `)
      .in('class_id', lessonIds)
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
        class_id: r.class_id,
        lesson_scheduled_at: lesson?.scheduled_at ?? null,
        teacher_name: teacherProfile?.full_name ?? null,
      }
    })
  }

  // Fetch reviews submitted by this student
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

  // ── Purge eligibility: check all linked teachers are 'former' ───────────────
  const { data: linkedLessonRows } = await supabase
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

  // ── Messages: fetch all student conversations ──────────────────────────────
  // Only select explicit columns — never select('*') on messages
  const { data: rawMessages } = await supabase
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
    />
  )
}
