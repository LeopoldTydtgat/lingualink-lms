import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAssignedTeacherIds } from '@/lib/access/trainingAssignment'
import StudentMessagesClient from './StudentMessagesClient'

export default async function StudentMessagesPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get the student record
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, photo_url')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) redirect('/student/login')

  // Get all teachers assigned to this student via the SHARED training-assignment gate
  // (NEW275) — identical rule to the one the send action enforces. The helper returns the
  // distinct assigned teacher_ids (fail-closed to empty on any error); we then load their
  // profiles for display. The id set is already distinct, so no manual dedup is needed.
  const admin = createAdminClient()
  let assignedTeacherIds: Set<string>
  try {
    assignedTeacherIds = await getAssignedTeacherIds(admin, student.id)
  } catch {
    // Render with no teacher contacts rather than crashing the page on a query error.
    assignedTeacherIds = new Set<string>()
  }

  // NEW346 adds `status` to the select: display-only data feeding the composer gate in
  // StudentMessagesClient. The list is NOT filtered by it — a former teacher's thread
  // must stay selectable and readable, it just loses its composer.
  let assignedTeachers: { id: string; full_name: string; photo_url: string | null; role: string; status: string | null }[] = []
  if (assignedTeacherIds.size > 0) {
    const { data: teacherProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, photo_url, role, status')
      .in('id', [...assignedTeacherIds])
    assignedTeachers = teacherProfiles ?? []
  }

  // Get all messages involving this student to build the contacts list
  const { data: allMessages } = await supabase
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
    .or(`sender_id.eq.${student.id},receiver_id.eq.${student.id}`)
    .order('created_at', { ascending: false })

  // Build contacts list — one entry per teacher/admin the student has messaged
  const contactMap = new Map<string, {
    id: string
    name: string
    photo_url: string | null
    type: string
    status: string | null
    latestMessage: typeof allMessages extends (infer T)[] | null ? T : never
    unreadCount: number
  }>()

  for (const msg of allMessages ?? []) {
    const contactId = msg.sender_id === student.id ? msg.receiver_id : msg.sender_id

    if (!contactMap.has(contactId)) {
      // Find teacher info from assignedTeachers
      const teacher = assignedTeachers.find(t => t.id === contactId)
      if (!teacher) continue // skip messages from unknown contacts

      contactMap.set(contactId, {
        id: teacher.id,
        name: teacher.full_name,
        photo_url: teacher.photo_url,
        type: teacher.role === 'admin' ? 'admin' : 'teacher',
        // NEW346: carries the composer gate. Null is not 'current' -> fails closed.
        status: teacher.status ?? null,
        latestMessage: msg,
        unreadCount: 0,
      })
    }

    // Count unread messages (sent to this student, not yet read)
    if (msg.receiver_id === student.id && !msg.read_at) {
      const entry = contactMap.get(msg.sender_id)
      if (entry) entry.unreadCount += 1
    }
  }

  const contacts = Array.from(contactMap.values())

  return (
    <StudentMessagesClient
      currentStudent={student}
      contacts={contacts}
      assignedTeachers={assignedTeachers}
    />
  )
}
