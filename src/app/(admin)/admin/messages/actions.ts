'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, newMessageEmailContent, studentNewMessageEmailContent } from '@/lib/email/templates'
import { sanitizeHtml } from '@/lib/sanitize-server'

async function assertAdmin() {
  // RLS-bound client — role lookup must run as the user, not via service role.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  const isAdmin =
    profile?.role === 'admin' ||
    (profile?.account_types ?? []).includes('school_admin')
  if (!isAdmin) throw new Error('Unauthorized')
}

export async function getAdminThreadMessages(teacherSideId: string, studentId: string) {
  await assertAdmin()

  const adminDb = createAdminClient()

  const { data } = await adminDb
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, admin_read_at, created_at')
    .or(
      `and(sender_id.eq.${teacherSideId},receiver_id.eq.${studentId}),` +
      `and(sender_id.eq.${studentId},receiver_id.eq.${teacherSideId}),` +
      `and(sender_type.eq.admin,receiver_id.eq.${studentId}),` +
      `and(sender_type.eq.admin,receiver_id.eq.${teacherSideId})`
    )
    .order('created_at', { ascending: true })

  return data ?? []
}

export async function sendAdminMessage(
  teacherSideId: string,
  studentId: string,
  content: string
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const adminDb = createAdminClient()

  const { data: adminProfile } = await adminDb
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!adminProfile || adminProfile.role !== 'admin') return { error: 'Unauthorized' }

  // Determine send direction: reply to whichever side sent last
  const { data: lastMessages } = await adminDb
    .from('messages')
    .select('sender_id, sender_type')
    .or(
      `and(sender_id.eq.${teacherSideId},receiver_id.eq.${studentId}),` +
      `and(sender_id.eq.${studentId},receiver_id.eq.${teacherSideId})`
    )
    .order('created_at', { ascending: false })
    .limit(1)

  const lastSenderType = lastMessages?.[0]?.sender_type

  // If last message was from student → send to teacher. Otherwise → send to student.
  const receiverId   = lastSenderType === 'student' ? teacherSideId : studentId
  const receiverType = lastSenderType === 'student' ? 'teacher' as const : 'student' as const

  const safeContent = sanitizeHtml(content)

  const { data: inserted, error } = await adminDb.from('messages').insert({
    sender_id:     adminProfile.id,
    sender_type:   'admin',
    receiver_id:   receiverId,
    receiver_type: receiverType,
    content:       safeContent,
    attachments:   [],
    admin_read_at: new Date().toISOString(),
  }).select().single()

  if (error) return { error: error.message }

  // Email notification to the recipient
  if (receiverType === 'student') {
    const { data: student } = await adminDb
      .from('students')
      .select('full_name, email')
      .eq('id', receiverId)
      .single()

    if (student?.email) {
      const subject = `Lingualink Online — New message from ${adminProfile.full_name}`
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject,
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject,
          bodyHtml: studentNewMessageEmailContent(adminProfile.full_name),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    }
  } else {
    const { data: teacher } = await adminDb
      .from('profiles')
      .select('full_name, email')
      .eq('id', receiverId)
      .single()

    if (teacher?.email) {
      const subject = `Lingualink Online — New message from ${adminProfile.full_name}`
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject,
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject,
          bodyHtml: newMessageEmailContent(adminProfile.full_name),
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    }
  }

  revalidatePath('/admin/messages')
  return { success: true, message: inserted }
}

export async function getUnreadAdminMessagesCount() {
  await assertAdmin()

  const adminDb = createAdminClient()

  // Mirrors src/app/(admin)/layout.tsx's nav badge query exactly — student-involving
  // conversations only, admin_read_at is null. Must run via admin client: the browser
  // role has zero column grants on admin_read_at, so Realtime payloads never carry it.
  const { count } = await adminDb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .is('admin_read_at', null)
    .or('sender_type.eq.student,receiver_type.eq.student')

  return count ?? 0
}

export async function markAdminThreadRead(teacherSideId: string, studentId: string) {
  await assertAdmin()

  const adminDb = createAdminClient()

  await adminDb
    .from('messages')
    .update({ admin_read_at: new Date().toISOString() })
    .or(
      `and(sender_id.eq.${teacherSideId},receiver_id.eq.${studentId}),` +
      `and(sender_id.eq.${studentId},receiver_id.eq.${teacherSideId})`
    )
    .is('admin_read_at', null)
}
