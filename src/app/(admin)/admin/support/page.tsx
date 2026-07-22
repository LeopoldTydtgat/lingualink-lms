import { createAdminClient } from '@/lib/supabase/admin'
import { requireStaff } from '@/lib/auth/requireStaff'
import { redirect } from 'next/navigation'
import AdminSupportClient from './AdminSupportClient'

export default async function AdminSupportPage() {
  // ROLE-5a: support inbox is staff-or-admin (requireStaff). Plain teachers
  // land back on the teacher portal.
  const user = await requireStaff()
  if (!user) redirect('/dashboard')

  const admin = createAdminClient()

  const { data: allMessages } = await admin
    .from('support_messages')
    .select('id, participant_id, participant_type, participant_auth_id, sender_role, content, read_at, created_at')
    .order('created_at', { ascending: false })

  // Group into conversations by participant_id
  const convMap = new Map<string, {
    participantId: string
    participantType: string
    participantAuthId: string
    latestMessage: { id: string; content: string; created_at: string; sender_role: string }
    unreadCount: number
  }>()

  for (const msg of allMessages ?? []) {
    if (!convMap.has(msg.participant_id)) {
      convMap.set(msg.participant_id, {
        participantId: msg.participant_id,
        participantType: msg.participant_type,
        participantAuthId: msg.participant_auth_id,
        latestMessage: msg,
        unreadCount: 0,
      })
    }
    if (!msg.read_at && msg.sender_role === 'user') {
      convMap.get(msg.participant_id)!.unreadCount++
    }
  }

  const teacherIds = [...convMap.values()]
    .filter(c => c.participantType === 'teacher')
    .map(c => c.participantId)

  const studentIds = [...convMap.values()]
    .filter(c => c.participantType === 'student')
    .map(c => c.participantId)

  const [{ data: teacherProfiles }, { data: studentRecords }] = await Promise.all([
    teacherIds.length > 0
      ? admin.from('profiles').select('id, full_name, photo_url').in('id', teacherIds)
      : Promise.resolve({ data: [] as any[] }),
    studentIds.length > 0
      ? admin.from('students').select('id, full_name, photo_url').in('id', studentIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const conversations = Array.from(convMap.values())
    .map(conv => {
      const isTeacher = conv.participantType === 'teacher'
      const record = isTeacher
        ? (teacherProfiles ?? []).find((p: any) => p.id === conv.participantId)
        : (studentRecords ?? []).find((s: any) => s.id === conv.participantId)
      return {
        participantId: conv.participantId,
        participantType: conv.participantType as 'teacher' | 'student',
        participantAuthId: conv.participantAuthId,
        participantName: record?.full_name ?? 'Unknown',
        participantPhotoUrl: record?.photo_url ?? null,
        latestMessage: conv.latestMessage,
        unreadCount: conv.unreadCount,
      }
    })
    .sort((a, b) =>
      new Date(b.latestMessage.created_at).getTime() -
      new Date(a.latestMessage.created_at).getTime()
    )

  const { data: faqs } = await admin
    .from('faqs')
    .select('id, question, answer, target_audience, display_order, is_active')
    .order('display_order', { ascending: true })

  return (
    <AdminSupportClient
      // ROLE-5a: one service identity — replies display as "LinguaLink Support",
      // never the staff member's personal name/photo.
      adminProfile={{ id: user.id, full_name: 'LinguaLink Support', photo_url: null }}
      conversations={conversations}
      initialFaqs={faqs ?? []}
    />
  )
}
