// src/app/(dashboard)/messages/page.tsx
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import MessagesClient from './MessagesClient'
import { getAssignedStudentIds } from '@/lib/access/trainingAssignment'

// Row from the messages explicit-column select below; mirrors MessagesClient's
// Message so the contacts prop stays assignable. Only created_at is read off
// latestMessage here.
type MessageRow = {
  id: string
  sender_id: string
  sender_type: string
  receiver_id: string
  receiver_type: string
  content: string
  attachments: unknown[]
  read_at: string | null
  created_at: string
}

interface PageProps {
  // Next.js 15 â€” searchParams is a Promise, must be awaited
  searchParams: Promise<{ openAdmin?: string; adminId?: string; studentId?: string }>
}

export default async function MessagesPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  // â”€â”€ Pre-open admin conversation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // When the teacher clicks "Message admin" in the RightPanel, they arrive here
  // with ?openAdmin=true&adminId={id}. We read those params and fetch the admin
  // profile so MessagesClient can auto-select the conversation immediately.
  const { openAdmin, adminId, studentId } = await searchParams

  const isAdmin = profile.role === 'admin'
  // NEW275: training-assignment student set - the SOLE access key for this teacher's
  // student-data reads here (deep-link resolve + new-message picker). A teacher may message
  // a student iff assigned to one of the student's trainings via training_teachers; bookings
  // are irrelevant. Admin is ungated (null). The message-history contacts section below is
  // intentionally NOT gated, so past conversations stay readable regardless of gate state.
  let assignedStudentIds: Set<string> | null = null
  if (!isAdmin) {
    try {
      assignedStudentIds = await getAssignedStudentIds(admin, user.id)
    } catch {
      // Render with an empty picker rather than crashing on a query error.
      assignedStudentIds = new Set<string>()
    }
  }

  let adminContact: {
    id: string
    type: string
    name: string
    photo_url: string | null
    latestMessage: null
    unreadCount: number
  } | null = null

  if (openAdmin === 'true' && adminId) {
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('id, full_name, role, photo_url')
      .eq('id', adminId)
      .single()

    if (adminProfile) {
      adminContact = {
        id: adminProfile.id,
        type: adminProfile.role, // 'admin'
        name: adminProfile.full_name,
        photo_url: adminProfile.photo_url ?? null,
        latestMessage: null,
        unreadCount: 0,
      }
    }
  }

  // ── Student deep-link ──────────────────────────────────────────────────────
  let studentContact: {
    id: string
    type: string
    name: string
    photo_url: string | null
    latestMessage: null
    unreadCount: number
  } | null = null

  if (studentId && (isAdmin || assignedStudentIds?.has(studentId))) {
    const { data: studentData } = await admin
      .from('students')
      .select('id, full_name, email, photo_url')
      .eq('id', studentId)
      .maybeSingle()
    if (studentData) {
      studentContact = {
        id: studentData.id,
        type: 'student',
        name: studentData.full_name,
        photo_url: studentData.photo_url ?? null,
        latestMessage: null,
        unreadCount: 0,
      }
    }
  }

  // â”€â”€ Build contacts list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Fetch all messages involving this user, newest first
  const { data: messages } = await supabase
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
    .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
    .order('created_at', { ascending: false })

  // Build a map of unique contacts from the message history
  // The "contact" in each message is whoever is NOT the current user
  const contactMap = new Map<string, {
    id: string
    type: string
    latestMessage: MessageRow
    unreadCount: number
  }>()

  for (const msg of (messages || [])) {
    const isFromMe = msg.sender_id === user.id
    const contactId = isFromMe ? msg.receiver_id : msg.sender_id
    const contactType = isFromMe ? msg.receiver_type : msg.sender_type

    if (!contactMap.has(contactId)) {
      contactMap.set(contactId, {
        id: contactId,
        type: contactType,
        latestMessage: msg,
        unreadCount: 0,
      })
    }
    // Count messages sent TO me that have not been read
    if (!isFromMe && !msg.read_at) {
      contactMap.get(contactId)!.unreadCount++
    }
  }

  // Separate contacts by type so we can look them up in the right table
  const studentContactIds: string[] = []
  const profileContactIds: string[] = []

  for (const [id, contact] of contactMap) {
    if (contact.type === 'student') studentContactIds.push(id)
    else profileContactIds.push(id)
  }

  // Use admin client — RLS blocks teacher role from reading students table directly
  const { data: studentDetails } = studentContactIds.length > 0
    ? await admin
        .from('students')
        .select('id, auth_user_id, full_name, email, photo_url')
        .in('id', studentContactIds)
    : { data: [] }

  // Fetch profile details for teacher/admin contacts
  const { data: profileDetails } = profileContactIds.length > 0
    ? await supabase
        .from('profiles')
        .select('id, full_name, role, photo_url')
        .in('id', profileContactIds)
    : { data: [] }

  // Combine contact map with display details
  const contacts = Array.from(contactMap.values()).map(contact => {
    const details = contact.type === 'student'
      ? (studentDetails || []).find((s: { id: string; auth_user_id: string; full_name: string; email: string | null; photo_url: string | null }) => s.id === contact.id)
      : (profileDetails || []).find((p: { id: string; full_name: string; role: string; photo_url: string | null }) => p.id === contact.id)

    return {
      ...contact,
      name: details?.full_name || 'Unknown',
      photo_url: details?.photo_url || null,
    }
  })

  // Sort by latest message time
  contacts.sort((a, b) =>
    new Date(b.latestMessage.created_at).getTime() -
    new Date(a.latestMessage.created_at).getTime()
  )

  // New-message picker students. Admin sees all active students; a teacher sees ONLY
  // students assigned to them via training_teachers (NEW275), computed once above.
  // The dead trainings.teacher_id column is no longer consulted.
  let allStudents: { id: string; full_name: string; email: string; photo_url: string | null }[] = []

  if (isAdmin) {
    const { data } = await supabase
      .from('students')
      .select('id, full_name, email, photo_url')
      .eq('status', 'current')
      .order('full_name')
    allStudents = data || []
  } else {
    // Use admin client — RLS blocks teacher role from reading these tables directly
    if (assignedStudentIds && assignedStudentIds.size > 0) {
      const { data } = await admin
        .from('students')
        .select('id, full_name, email, photo_url')
        .in('id', [...assignedStudentIds])
        .eq('status', 'current')
        .order('full_name')
      allStudents = data || []
    }
  }

  return (
    <MessagesClient
      currentUser={profile}
      contacts={contacts}
      allStudents={allStudents || []}
      // The teacher's currently-assigned student ids (NEW275) — mirrors the send-action
      // gate exactly. Used to disable the composer for a stale history thread whose
      // student is no longer assigned (admin is ungated, so an empty array is fine there).
      assignedStudentIds={assignedStudentIds ? [...assignedStudentIds] : []}
      // Pass the pre-resolved admin contact if the URL requested it.
      // MessagesClient will auto-select this conversation on mount.
      initialContact={adminContact ?? studentContact}
    />
  )
}
