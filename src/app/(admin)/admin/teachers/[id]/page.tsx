import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import TeacherDetailClient from './TeacherDetailClient'
import type { AdminConversation } from './TeacherDetailClient'

export default async function TeacherDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createAdminClient()

  // Fetch teacher profile — includes sensitive admin-only fields
  const { data: teacher, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !teacher) notFound()

  // Fetch teacher's classes (most recent 50)
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      students (
        full_name
      )
    `)
    .eq('teacher_id', id)
    .order('scheduled_at', { ascending: false })
    .limit(50)

  // Fetch teacher's invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, month, total_amount, status, created_at')
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
    />
  )
}
