import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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

  // Get all teachers assigned to this student via training_teachers
  const { data: trainingTeachers } = await supabase
    .from('training_teachers')
    .select(`
      teacher_id,
      profiles!inner(id, full_name, email, photo_url, role)
    `)
    .in(
      'training_id',
      (
        await supabase
          .from('trainings')
          .select('id')
          .eq('student_id', student.id)
      ).data?.map(t => t.id) ?? []
    )

  // Flatten and deduplicate assigned teachers
  const seenIds = new Set<string>()
  const assignedTeachers: { id: string; full_name: string; email: string; photo_url: string | null; role: string }[] = []

  for (const row of trainingTeachers ?? []) {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
    if (profile && !seenIds.has(profile.id)) {
      seenIds.add(profile.id)
      assignedTeachers.push(profile)
    }
  }

  // Get all messages involving this student to build the contacts list
  const { data: allMessages } = await supabase
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${student.id},receiver_id.eq.${student.id}`)
    .order('created_at', { ascending: false })

  // Build contacts list — one entry per teacher/admin the student has messaged
  const contactMap = new Map<string, {
    id: string
    name: string
    email: string
    photo_url: string | null
    type: string
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
        email: teacher.email,
        photo_url: teacher.photo_url,
        type: teacher.role === 'admin' ? 'admin' : 'teacher',
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
