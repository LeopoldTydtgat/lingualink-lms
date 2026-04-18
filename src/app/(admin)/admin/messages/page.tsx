import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import AdminMessagesClient from './AdminMessagesClient'

interface RawMessage {
  id: string
  sender_id: string
  sender_type: string
  receiver_id: string
  receiver_type: string
  content: string
  read_at: string | null
  created_at: string
}

export default async function AdminMessagesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminDb = createAdminClient()

  const { data: adminProfile } = await adminDb
    .from('profiles')
    .select('id, full_name, photo_url')
    .eq('id', user.id)
    .single()

  if (!adminProfile) redirect('/login')

  // Fetch all messages newest-first — service role bypasses RLS
  const { data: allMessages } = await adminDb
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, read_at, created_at')
    .order('created_at', { ascending: false })

  // Build conversation map keyed by "teacherSideId:studentId"
  // "Teacher side" = whichever participant is NOT the student (teacher or admin)
  const convMap = new Map<string, {
    teacherSideId: string
    studentId: string
    latestMessage: RawMessage
    unreadCount: number
  }>()

  for (const msg of (allMessages ?? []) as RawMessage[]) {
    let teacherSideId: string
    let studentId: string

    if (msg.sender_type === 'student') {
      studentId = msg.sender_id
      teacherSideId = msg.receiver_id
    } else if (msg.receiver_type === 'student') {
      studentId = msg.receiver_id
      teacherSideId = msg.sender_id
    } else {
      // admin↔teacher or teacher↔teacher — skip for this view
      continue
    }

    const key = `${teacherSideId}:${studentId}`
    if (!convMap.has(key)) {
      convMap.set(key, { teacherSideId, studentId, latestMessage: msg, unreadCount: 0 })
    }
    if (!msg.read_at) {
      convMap.get(key)!.unreadCount++
    }
  }

  const teacherSideIds = [...new Set([...convMap.values()].map(c => c.teacherSideId))]
  const studentIds    = [...new Set([...convMap.values()].map(c => c.studentId))]

  const [{ data: teacherProfiles }, { data: studentRecords }] = await Promise.all([
    teacherSideIds.length > 0
      ? adminDb.from('profiles').select('id, full_name, photo_url, role').in('id', teacherSideIds)
      : { data: [] as any[] },
    studentIds.length > 0
      ? adminDb.from('students').select('id, full_name, photo_url').in('id', studentIds)
      : { data: [] as any[] },
  ])

  const conversations = Array.from(convMap.values())
    .map(conv => {
      const teacher = (teacherProfiles ?? []).find((p: any) => p.id === conv.teacherSideId)
      const student = (studentRecords  ?? []).find((s: any) => s.id === conv.studentId)
      return {
        key:                conv.teacherSideId + ':' + conv.studentId,
        teacherSideId:      conv.teacherSideId,
        teacherSideName:    teacher?.full_name  ?? 'Unknown',
        teacherSidePhotoUrl: teacher?.photo_url ?? null,
        studentId:          conv.studentId,
        studentName:        student?.full_name  ?? 'Unknown',
        studentPhotoUrl:    student?.photo_url  ?? null,
        latestMessage:      conv.latestMessage,
        unreadCount:        conv.unreadCount,
      }
    })
    .sort((a, b) =>
      new Date(b.latestMessage.created_at).getTime() -
      new Date(a.latestMessage.created_at).getTime()
    )

  return (
    <AdminMessagesClient
      currentAdmin={adminProfile}
      conversations={conversations}
    />
  )
}
