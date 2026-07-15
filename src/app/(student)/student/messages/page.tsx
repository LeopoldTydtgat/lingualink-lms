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
  //
  // This array must keep holding ASSIGNED teachers only: the client derives both the
  // new-message picker (filteredTeachers) and the assignment half of isBlockedContact
  // from it. Historical counterparts are resolved separately below and deliberately
  // stay OUT of it, which is exactly what makes their threads read-only.
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

  // NEW283: resolve the counterparts this student has HISTORY with but is no longer
  // assigned to. Without these the contacts loop below dropped the whole thread (the old
  // `if (!teacher) continue`), silently deleting past conversations from the UI the moment
  // an assignment ended — contradicting the NEW346 design, which keeps history listed and
  // readable and gates only the composer.
  //
  // Fetched with the ADMIN client on purpose: the student role's RLS visibility on an
  // UNASSIGNED teacher's profile is unverified, and a regular-client miss would silently
  // reintroduce the very bug this fixes. This page already uses the admin client for the
  // assignment lookup above. Only display fields are selected — no privileged columns.
  // Fail soft: on a query error fall back to empty, which degrades to today's behaviour
  // (thread skipped) rather than crashing the page.
  const historicalContactIds = new Set<string>()
  for (const msg of allMessages ?? []) {
    const contactId = msg.sender_id === student.id ? msg.receiver_id : msg.sender_id
    if (!assignedTeacherIds.has(contactId)) historicalContactIds.add(contactId)
  }

  let historicalContacts: { id: string; full_name: string; photo_url: string | null; role: string; status: string | null }[] = []
  if (historicalContactIds.size > 0) {
    const { data: historicalProfiles, error: historicalError } = await admin
      .from('profiles')
      .select('id, full_name, photo_url, role, status')
      .in('id', [...historicalContactIds])
    historicalContacts = historicalError ? [] : (historicalProfiles ?? [])
  }

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
      // NEW283: contacts now include HISTORICAL (unassigned) counterparts, not just
      // currently-assigned ones — resolve from assignedTeachers first, then fall back to
      // the historical profiles fetched above. Listing an unassigned counterpart does NOT
      // grant send permission: the client's isBlockedContact gate keys off the
      // assignedTeachers prop (which excludes these), so the thread renders read-only,
      // and the NEW275 gate in the send action rejects any send to them authoritatively.
      // The `continue` remains only as the final fallback for a counterpart id matching
      // neither list (e.g. a hard-deleted profile), which has nothing to render.
      const teacher =
        assignedTeachers.find(t => t.id === contactId) ??
        historicalContacts.find(t => t.id === contactId)
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
